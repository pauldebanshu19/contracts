import { estimateRequestTokens, type ChatMessage } from "../llm/types";
import { fitConversation, fitHistory } from "./budget";
import { historyMessages, researchSystemPrompt } from "./prompts";
import type { ModeResult, Run } from "./run";
import { streamModel } from "./stream";
import { ToolRunner, toolDefinitions } from "./tools";

/**
 * Research mode (PRD Part C): the model decides what to read with five tools,
 * and this loop decides how long it may go on.
 *
 * It is a plain loop over the chat API rather than an agent framework, so the
 * limits are visible in one place:
 *  - at most `maxRounds` rounds, `maxCallsPerRound` tool calls each, and a token budget
 *  - a repeated call is answered with "already returned above"
 *  - three invalid calls in a row turn the tools off
 *  - at any limit, one last call without tools writes the answer from what was read
 * A bad tool call becomes a message the model can correct; it never fails the request.
 */

const INVALID_LIMIT = 3;

const FINAL_INSTRUCTION =
  "You have reached the limit on tool calls. Answer now from what you have read. Start with the status tag, use <status>partial</status> if you could not check everything, and say what you did not check.";

export async function runResearch(run: Run): Promise<ModeResult & { intercepted?: boolean }> {
  const { ctx, settings, tracker } = run;
  const tools = toolDefinitions();
  const budget = settings.promptBudget;
  // Tool results are sized so a couple of them fit in one request alongside the instructions.
  const resultChars = Number.isFinite(budget) ? Math.max(2000, Math.min(9000, Math.floor((budget - 2500) * 2))) : 9000;
  const runner = new ToolRunner(run, resultChars);

  const messages: ChatMessage[] = [
    { role: "system", content: researchSystemPrompt(run.docs, settings.maxRounds) },
    ...historyMessages(fitHistory(ctx.history, budget * 0.15)),
    { role: "user", content: ctx.question },
  ];
  // Every request is cut to fit; old tool results are dropped first, and may then be asked for again.
  const fit = (withTools: boolean) => {
    const fitted = fitConversation(messages, withTools ? tools : undefined, budget);
    if (fitted.removed) runner.allowRepeats();
    return fitted.messages;
  };

  // A "not found" before everything was read is not shown; the caller reads the whole document instead.
  const intercept = (status: string) => status === "not_found" && !tracker.isComplete();
  let spent = 0;
  let invalidStreak = 0;

  for (let round = 0; round < settings.maxRounds; round++) {
    const request = fit(true);
    spent += estimateRequestTokens(request, tools);
    if (spent > settings.tokenBudget) break;

    const result = await streamModel({
      llm: ctx.llm,
      request: { messages: request, tools, purpose: "answer" },
      writer: ctx.writer,
      verify: run.verify,
      signal: ctx.signal,
      intercept,
      holdUntilStatus: true,
    });
    if (result.intercepted) return { status: "not_found", intercepted: true };
    if (result.aborted) return { status: result.status ?? "answered", aborted: true };
    // No tool calls, or it wrote the answer and asked for tools as well: the answer stands.
    if (!result.toolCalls.length || result.shown) return { status: result.status ?? "answered" };

    messages.push({ role: "assistant", content: result.raw, toolCalls: result.toolCalls });
    for (const [index, call] of result.toolCalls.entries()) {
      // Every tool call needs a reply or the provider rejects the next request.
      if (index >= settings.maxCallsPerRound) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Not run: at most ${settings.maxCallsPerRound} tool calls per round. Call it again in the next round if you still need it.`,
        });
        continue;
      }
      if (invalidStreak >= INVALID_LIMIT) {
        messages.push({ role: "tool", toolCallId: call.id, content: "Not run: too many invalid calls in a row." });
        continue;
      }

      const step = ctx.writer.startStep(call.name, `${call.name}…`);
      const outcome = await runner.execute(call);
      ctx.writer.endStep(step, { label: outcome.label, detail: outcome.detail, status: outcome.ok ? "done" : "error" });
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
      invalidStreak = outcome.ok ? 0 : invalidStreak + 1;
    }
    if (invalidStreak >= INVALID_LIMIT) break;
  }

  // A limit was reached: one last call with tools disabled (PRD "Loop rules").
  messages.push({ role: "user", content: FINAL_INSTRUCTION });
  const result = await streamModel({
    llm: ctx.llm,
    request: { messages: fit(false), purpose: "answer" },
    writer: ctx.writer,
    verify: run.verify,
    signal: ctx.signal,
    intercept,
  });
  if (result.intercepted) return { status: "not_found", intercepted: true, extras: { stoppedAtLimit: true } };
  return { status: result.status ?? "answered", aborted: result.aborted, extras: { stoppedAtLimit: true } };
}
