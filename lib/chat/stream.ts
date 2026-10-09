import { isAbort, type Llm, type LlmRequest, type ToolCall } from "../llm/types";
import type { AnswerStatus, CitationDTO } from "../types";
import { CiteStreamParser, PageRefScrubber, type CiteEvent } from "../verify/cite-stream";
import type { AnswerWriter } from "./writer";


export type VerifyFn = (alias: string | null, quote: string) => Omit<CitationDTO, "ordinal"> & { modelQuote: string };

export interface StreamOptions {
  llm: Llm;
  request: LlmRequest;
  writer: AnswerWriter;
  verify: VerifyFn;
  signal: AbortSignal;

  intercept?: (status: AnswerStatus) => boolean;
  
  holdUntilStatus?: boolean;
}

export interface StreamResult {
  status: AnswerStatus | null;
  /** Quotes the model wrote, verified or not. */
  cites: number;
  toolCalls: ToolCall[];
  /** The raw model text, for the conversation history of a tool loop. */
  raw: string;
  intercepted: boolean;
  aborted: boolean;
  /** True when this call's text was shown as the answer. */
  shown: boolean;
}

export async function streamModel(options: StreamOptions): Promise<StreamResult> {
  const { llm, writer, verify, signal } = options;
  const parser = new CiteStreamParser();
  const scrubber = new PageRefScrubber();
  const ordinals = new Map<number, number>();
  const result: StreamResult = { status: null, cites: 0, toolCalls: [], raw: "", intercepted: false, aborted: false, shown: false };

  // The call can be cut short by the user (outer signal) or by an intercepted status (inner).
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const flushText = () => {
    const rest = scrubber.end();
    if (rest) writer.text(rest);
  };

  const show = (event: CiteEvent) => {
    result.shown = true;
    switch (event.type) {
      case "text": {
        const out = scrubber.push(event.text);
        if (out) writer.text(out);
        break;
      }
      case "cite_open":
        flushText();
        ordinals.set(event.index, writer.openCite());
        break;
      case "cite": {
        result.cites++;
        const ordinal = ordinals.get(event.index) ?? writer.openCite();
        writer.resolveCite(ordinal, verify(event.doc, event.quote));
        break;
      }
      case "cite_abort": {
        const ordinal = ordinals.get(event.index);
        if (ordinal !== undefined) writer.dropCite(ordinal);
        break;
      }
      case "status":
        break;
    }
  };

  let holding = true;
  let held: CiteEvent[] = [];
  const release = () => {
    holding = false;
    for (const event of held) show(event);
    held = [];
  };

  const consume = (events: CiteEvent[]): boolean => {
    for (const event of events) {
      if (event.type === "status") {
        result.status = event.status;
        if (holding && options.intercept?.(event.status)) {
          result.intercepted = true;
          return false;
        }
        if (holding) release();
        continue;
      }
      if (!holding) {
        show(event);
        continue;
      }
      held.push(event);
      // No status tag at the start: unless we were told to wait for one, treat this as the answer.
      const substantive = event.type !== "text" || event.text.trim().length > 0;
      if (substantive && !options.holdUntilStatus) release();
    }
    return true;
  };

  try {
    for await (const event of llm.stream({ ...options.request, signal: inner.signal })) {
      if (event.type === "tool_calls") {
        result.toolCalls.push(...event.calls);
        continue;
      }
      result.raw += event.text;
      if (!consume(parser.push(event.text))) {
        inner.abort();
        break;
      }
    }
  } catch (error) {
    if (!isAbort(error, inner.signal)) throw error;
    if (signal.aborted) result.aborted = true;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  if (result.intercepted) return result;
  if (signal.aborted) result.aborted = true;

  consume(parser.end({ aborted: result.aborted }));
  // The status can arrive last, in the final flush, and still be one that must not be shown.
  if (result.intercepted) return result;
  if (holding) {
    // Held to the end. With tool calls it was a preamble; without, it is the answer.
    if (result.toolCalls.length) held = [];
    else release();
  }
  flushText();
  return result;
}
