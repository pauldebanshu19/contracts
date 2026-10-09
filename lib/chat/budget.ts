import { estimateRequestTokens, estimateTokens, type ChatMessage, type ToolDefinition } from "../llm/types";

/**
 * Keeping every request under the prompt budget (see promptTokenBudget). With
 * no limit configured the budget is Infinity and nothing here changes anything.
 */

/** The most recent turns that fit in `maxTokens`, oldest first. */
export function fitHistory<T extends { content: string }>(history: T[], maxTokens: number): T[] {
  if (!Number.isFinite(maxTokens)) return history;
  const kept: T[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content) + 4;
    if (used + cost > maxTokens) break;
    kept.unshift(history[i]);
    used += cost;
  }
  // A conversation must not start with an orphaned assistant turn.
  while (kept.length && (kept[0] as { role?: string }).role === "assistant") kept.shift();
  return kept;
}

/** Take items in priority order while their total size stays within `maxTokens`. Always keeps at least `minimum`. */
export function takeWithin<T>(items: T[], size: (item: T) => number, maxTokens: number, minimum = 1): T[] {
  if (!Number.isFinite(maxTokens)) return items;
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = size(item);
    if (used + cost > maxTokens && out.length >= minimum) break;
    out.push(item);
    used += cost;
  }
  return out;
}

export const REMOVED_RESULT =
  "[This earlier result was removed to keep the request within the model's size limit. Call the tool again if you still need it.]";

/**
 * Shrink a tool conversation to fit: older tool results are replaced by a
 * short note, oldest first; as a last resort the largest remaining one is cut.
 * The messages stay a valid exchange (every tool call keeps its reply).
 */
export function fitConversation(messages: ChatMessage[], tools: ToolDefinition[] | undefined, budget: number): { messages: ChatMessage[]; removed: number } {
  if (!Number.isFinite(budget)) return { messages, removed: 0 };
  const out = messages.map((m) => ({ ...m }));
  let removed = 0;
  const size = () => estimateRequestTokens(out, tools);

  const toolIndexes = out.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i !== -1);
  // Keep the newest round's results; remove from the oldest.
  for (const i of toolIndexes.slice(0, -1)) {
    if (size() <= budget) break;
    if (out[i].content !== REMOVED_RESULT) {
      out[i].content = REMOVED_RESULT;
      removed++;
    }
  }
  while (size() > budget) {
    const largest = out.reduce((best, m, i) => (m.role === "tool" && m.content.length > (out[best]?.content.length ?? -1) ? i : best), -1);
    if (largest === -1 || out[largest].content.length < 400) break;
    const over = (size() - budget) * 4 + 200;
    const keep = Math.max(200, out[largest].content.length - over);
    out[largest].content = `${out[largest].content.slice(0, keep)}\n[truncated to fit the model's request size limit]`;
  }
  return { messages: out, removed };
}
