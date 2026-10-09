import OpenAI from "openai";
import { config, llmConfigured } from "../config";
import { TokenBucket } from "./limiter";
import {
  LlmError,
  LlmToolsUnsupportedError,
  estimateRequestTokens,
  isAbort,
  type ChatMessage,
  type Llm,
  type LlmEvent,
  type LlmRequest,
  type ToolCall,
} from "./types";

/** Any OpenAI-compatible chat API, chosen by LLM_BASE_URL (OpenRouter, OpenAI, Gemini, a local server). */

type Param = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toParam(message: ChatMessage): Param {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content } as Param;
}

function explain(error: unknown, usedTools: boolean): Error {
  const status = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);

  // Providers word this differently; all of them mention tools or functions.
  if (usedTools && status !== undefined && [400, 404, 422, 501].includes(status) && /tool|function/i.test(message)) {
    return new LlmToolsUnsupportedError({ cause: error });
  }
  if (status === 401 || status === 403) {
    return new LlmError("The model provider rejected the API key. Check LLM_API_KEY.", { cause: error });
  }
  if (status === 413 || /request too large/i.test(message)) {
    return new LlmError("A request was larger than the model's per-minute token limit allows. Try a narrower question, or raise LLM_TPM if the account's limit is higher.", { cause: error });
  }
  if (status === 429 && /per day|TPD|RPD/i.test(message)) {
    return new LlmError("The model provider's daily limit for this account has been reached. Try again later or upgrade the plan.", { cause: error });
  }
  if (status === 402) {
    return new LlmError("The model provider says the account is out of credit.", { cause: error });
  }
  if (status === 404) {
    return new LlmError(`The model "${config().LLM_MODEL}" wasn't found at this provider. Check LLM_MODEL.`, {
      cause: error,
    });
  }
  if (status === 429) {
    return new LlmError("The model provider is rate-limiting requests. Wait a moment and try again.", { cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new LlmError("The model provider had an error. Try again.", { cause: error });
  }
  return new LlmError(`The model request failed: ${message}`, { cause: error });
}

/** Completion tokens assumed for a request when reserving rate-limit capacity. Corrected from real usage afterwards. */
const OUTPUT_GUESS = 700;

export class OpenAiLlm implements Llm {
  private readonly client: OpenAI;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor() {
    const c = config();
    // Under a tight per-minute limit a 429 is routine; the SDK waits for the provider's retry-after.
    this.client = new OpenAI({ apiKey: c.LLM_API_KEY, baseURL: c.LLM_BASE_URL, maxRetries: c.LLM_TPM ? 6 : 2, timeout: 180_000 });
  }

  private modelFor(request: LlmRequest): string {
    const c = config();
    return request.purpose === "scan" && c.LLM_SCAN_MODEL ? c.LLM_SCAN_MODEL : c.LLM_MODEL;
  }

  /** Providers such as Groq limit tokens per minute per model, so each model gets its own bucket. */
  private bucket(model: string): TokenBucket | null {
    const tpm = config().LLM_TPM;
    if (!tpm) return null;
    let bucket = this.buckets.get(model);
    if (!bucket) this.buckets.set(model, (bucket = new TokenBucket(tpm)));
    return bucket;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const usedTools = Boolean(request.tools?.length);
    const model = this.modelFor(request);
    const effort = config().LLM_REASONING_EFFORT;
    const bucket = this.bucket(model);
    const estimate = estimateRequestTokens(request.messages, request.tools) + OUTPUT_GUESS;
    let actual: number | null = null;
    try {
      await bucket?.take(estimate, request.signal);
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages: request.messages.map(toParam),
          stream: true,
          temperature: 0,
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(usedTools
            ? {
                tools: request.tools!.map((tool) => ({
                  type: "function" as const,
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
              }
            : {}),
        },
        { signal: request.signal },
      );

      // Tool calls arrive in fragments keyed by index.
      const pending = new Map<number, ToolCall>();
      for await (const chunk of stream) {
        // Groq reports usage on the last chunk under x_groq; OpenAI-style providers under usage.
        const usage = (chunk as { x_groq?: { usage?: { total_tokens?: number } } }).x_groq?.usage ?? chunk.usage;
        if (usage?.total_tokens) actual = usage.total_tokens;
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: "text", text: delta.content };
        for (const part of delta.tool_calls ?? []) {
          const call = pending.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          pending.set(part.index, call);
        }
      }
      if (pending.size) {
        const calls = [...pending.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
        yield { type: "tool_calls", calls };
      }
    } catch (error) {
      if (isAbort(error, request.signal)) throw error;
      throw explain(error, usedTools);
    } finally {
      if (bucket && actual !== null) bucket.settle(estimate, actual);
    }
  }
}

const globals = globalThis as unknown as { __contractsLlm?: { llm: Llm; key: string } };

export function getLlm(): Llm {
  if (!llmConfigured()) {
    throw new LlmError("No model is configured. Set LLM_API_KEY and LLM_MODEL in .env, then restart the server.");
  }
  // Rebuilt if the key or endpoint changed (a reloaded .env in development).
  const c = config();
  const key = `${c.LLM_BASE_URL}|${c.LLM_API_KEY}|${c.LLM_TPM}`;
  if (globals.__contractsLlm?.key !== key) globals.__contractsLlm = { llm: new OpenAiLlm(), key };
  return globals.__contractsLlm.llm;
}
