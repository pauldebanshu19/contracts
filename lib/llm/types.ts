/**
 * The one interface the app uses to talk to a model. The agent loop and the
 * answer pipeline depend on this, not on a particular provider's client.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it. It may not parse. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type LlmEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ToolCall[] };

/** What a request is for. Scan batches can go to a different (cheaper) model than answers. */
export type LlmPurpose = "answer" | "scan" | "summary";

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  maxTokens?: number;
  purpose?: LlmPurpose;
}

export interface Llm {
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}

/** A failure with a message that is safe and useful to show the user. */
export class LlmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
  }
}

/** The provider or model refused a request because it included tools. */
export class LlmToolsUnsupportedError extends LlmError {
  constructor(options?: ErrorOptions) {
    super("This model doesn't support tool calling.", options);
    this.name = "LlmToolsUnsupportedError";
  }
}

export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (error as { name?: string })?.name;
  return name === "AbortError" || name === "APIUserAbortError";
}

/** Run a request to completion and return its text. */
export async function complete(llm: Llm, request: LlmRequest): Promise<string> {
  let text = "";
  for await (const event of llm.stream(request)) {
    if (event.type === "text") text += event.text;
  }
  return text;
}

/**
 * Rough size of a request in tokens: about four characters per token, which
 * slightly overestimates for English, so budgets built on it err on the safe side.
 */
export function estimateRequestTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let chars = 0;
  for (const message of messages) {
    // Each message carries a few tokens of role and formatting overhead.
    chars += message.content.length + 16;
    for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length + 16;
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
