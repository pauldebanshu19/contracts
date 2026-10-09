import { complete, isAbort, type ChatMessage, type Llm } from "../llm/types";
import type { Segment } from "../text/normalize";
import { estimateTokens } from "../text/segment";
import { CiteStreamParser } from "../verify/cite-stream";
import { displaySlice, verifyQuote, type VerifiableDoc } from "../verify/quote";
import type { ChunkRow } from "./chunks";
import { SCAN_CORRECTION, chunkLabel, scanSystemPrompt, scanUserPrompt, type PromptDoc, type ScanExcerpt } from "./prompts";



export interface ScanDoc extends PromptDoc {
  id: string;
  verifiable: VerifiableDoc;
  chunks: ChunkRow[];
}

export interface FoundExcerpt extends ScanExcerpt, Segment {
  documentId: string;
  /** Found from a quote that wasn't word for word: the text is the document's, the match was by shared words. */
  inexact?: boolean;
}

export interface ScanBatch {
  doc: ScanDoc;
  chunks: ChunkRow[];
}

export interface ScanResult {
  excerpts: FoundExcerpt[];
  /** Chunk ordinals read successfully, per document. */
  read: Map<string, number[]>;
  /** Chunk ordinals in batches that failed, per document. */
  failed: Map<string, number[]>;
  /**
   * Batches where the model pointed at something relevant that couldn't be
   * confirmed or located. Not evidence of absence: the caller must not claim it.
   */
  uncertain: ScanBatch[];
  /** Reading stopped at the time limit with batches still unread. Those are in neither `read` nor `failed`. */
  timedOut: boolean;
}

export interface ScanOptions {
  docs: ScanDoc[];
  question: string;
  llm: Llm;
  signal: AbortSignal;
  concurrency: number;
  batchTokens: number;
  /** Stop reading at this time, leaving the rest unread. For hosts that cut long requests off. */
  stopAt?: number;
  onBatchStart?: (batch: ScanBatch, index: number, total: number) => void;
}

const ATTEMPTS = 2;
const CONTEXT_CHARS = 280;
const MAX_EXCERPTS = 120;

export function makeBatches(docs: ScanDoc[], batchTokens: number): ScanBatch[] {
  const batches: ScanBatch[] = [];
  for (const doc of docs) {
    let current: ChunkRow[] = [];
    let tokens = 0;
    for (const chunk of doc.chunks) {
      const size = estimateTokens(chunk.text);
      if (current.length && tokens + size > batchTokens) {
        batches.push({ doc, chunks: current });
        current = [];
        tokens = 0;
      }
      current.push(chunk);
      tokens += size;
    }
    if (current.length) batches.push({ doc, chunks: current });
  }
  return batches;
}

/** Grow a match to the sentence around it, so the answer step sees who "shall" do what. */
function withContext(text: string, match: Segment, limit: Segment): Segment {
  let start = match.start;
  const floor = Math.max(limit.start, match.start - CONTEXT_CHARS);
  while (start > floor && !/[.;:!?\n]/.test(text[start - 1])) start--;
  if (start === floor && start > limit.start) start = match.start; // no sentence start nearby: don't cut mid-word
  while (start < match.start && /\s/.test(text[start])) start++;

  let end = match.end;
  const ceiling = Math.min(limit.end, match.end + CONTEXT_CHARS);
  while (end < ceiling && !/[.;!?\n]/.test(text[end - 1])) end++;
  if (end === ceiling && end < limit.end) end = match.end;
  return { start, end };
}

interface ParsedQuote {
  quote: string;
  note: string;
}

/** Pull `<cite>quote</cite> note` lines out of a batch reply. */
export function parseScanReply(reply: string): ParsedQuote[] {
  const parser = new CiteStreamParser();
  const quotes: ParsedQuote[] = [];
  let note = "";
  const finishNote = () => {
    const last = quotes[quotes.length - 1];
    if (last) last.note = note.split("\n")[0].replace(/^[\s:\u2013\u2014-]+/, "").trim().slice(0, 240);
    note = "";
  };
  for (const event of [...parser.push(reply), ...parser.end()]) {
    if (event.type === "cite") {
      finishNote();
      quotes.push({ quote: event.quote, note: "" });
    } else if (event.type === "text") {
      note += event.text;
    }
  }
  finishNote();
  return quotes;
}

const SENTENCE = /[^.;!?]+(?:[.;!?]+(?=\s|$)|$)/g;
const LOOSE_MIN_SHARE = 0.6;

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2));
}

/**
 * Where an inexact quote most likely came from: the run of one to three
 * sentences in the batch sharing the most of its words. Used only to hand the
 * answer step the document's real text; quotes in the answer are still
 * verified exactly.
 */
export function locateLoosely(text: string, quote: string, ranges: Segment[]): Segment | null {
  const wanted = contentWords(quote);
  if (wanted.size < 4) return null;
  let best: Segment | null = null;
  let bestShare = 0;
  for (const range of ranges) {
    const slice = text.slice(range.start, range.end);
    const sentences = [...slice.matchAll(SENTENCE)].map((m) => ({ start: range.start + m.index!, end: range.start + m.index! + m[0].length }));
    for (let i = 0; i < sentences.length; i++) {
      for (let size = 1; size <= 3 && i + size <= sentences.length; size++) {
        const window = { start: sentences[i].start, end: sentences[i + size - 1].end };
        const words = contentWords(text.slice(window.start, window.end));
        let shared = 0;
        for (const w of wanted) if (words.has(w)) shared++;
        const share = shared / wanted.size;
        // A longer window must do clearly better to win.
        if (share > bestShare + 0.05 * (size - 1)) {
          bestShare = share;
          best = window;
        }
      }
    }
  }
  if (!best || bestShare < LOOSE_MIN_SHARE) return null;
  while (best.start < best.end && /\s/.test(text[best.start])) best.start++;
  return best;
}

interface BatchOutcome {
  excerpts: FoundExcerpt[];
  /** The model flagged something that could be neither verified nor located. */
  uncertain: boolean;
}

async function runBatch(batch: ScanBatch, options: ScanOptions): Promise<BatchOutcome> {
  const { doc, chunks } = batch;
  const ranges = chunks.map((c) => ({ start: c.start, end: c.end }));
  const messages: ChatMessage[] = [
    { role: "system", content: scanSystemPrompt() },
    { role: "user", content: scanUserPrompt(doc, chunks, options.question) },
  ];
  const ask = () => complete(options.llm, { purpose: "scan", messages, signal: options.signal });

  const excerptAt = (range: Segment, note: string, inexact: boolean): FoundExcerpt | null => {
    const chunk = chunks.find((c) => range.start >= c.start && range.start < c.end);
    if (!chunk) return null; // real text, but from a part this batch wasn't given
    const context = withContext(doc.verifiable.text, range, chunk);
    return {
      documentId: doc.id,
      alias: doc.alias,
      label: chunkLabel(chunk),
      text: displaySlice(doc.verifiable.text, context),
      note,
      start: context.start,
      end: context.end,
      ...(inexact ? { inexact } : {}),
    };
  };

  const check = (reply: string) => {
    const found: FoundExcerpt[] = [];
    const missed: { quote: string; note: string }[] = [];
    for (const item of parseScanReply(reply)) {
      const verified = verifyQuote(item.quote, doc.verifiable, { preferred: ranges });
      const match = verified.verified ? verified.matches[verified.primary] : null;
      const excerpt = match ? excerptAt({ start: match.start, end: match.end }, item.note, false) : null;
      if (excerpt) found.push(excerpt);
      else missed.push(item);
    }
    return { found, missed };
  };

  const reply = await ask();
  const first = check(reply);
  if (first.found.length || !first.missed.length) return { excerpts: first.found, uncertain: false };

  // The model says something here is relevant but didn't copy it exactly. That is not evidence
  // of absence: ask once more for exact words, then fall back to the closest real sentences.
  messages.push({ role: "assistant", content: reply }, { role: "user", content: SCAN_CORRECTION(first.missed.map((m) => m.quote)) });
  const second = check(await ask());
  if (second.found.length) return { excerpts: second.found, uncertain: false };

  const located: FoundExcerpt[] = [];
  for (const item of [...first.missed, ...second.missed]) {
    const range = locateLoosely(doc.verifiable.text, item.quote, ranges);
    const excerpt = range ? excerptAt(range, item.note, true) : null;
    if (excerpt && !located.some((e) => e.start === excerpt.start)) located.push(excerpt);
  }
  return { excerpts: located, uncertain: located.length === 0 };
}

export async function scanDocuments(options: ScanOptions): Promise<ScanResult> {
  const batches = makeBatches(options.docs, options.batchTokens);
  const result: ScanResult = { excerpts: [], read: new Map(), failed: new Map(), uncertain: [], timedOut: false };
  const timeUp = options.stopAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, options.stopAt - Date.now()));
  const batchOptions: ScanOptions = timeUp ? { ...options, signal: AbortSignal.any([options.signal, timeUp]) } : options;
  const record = (map: Map<string, number[]>, batch: ScanBatch) => {
    const list = map.get(batch.doc.id) ?? [];
    list.push(...batch.chunks.map((c) => c.ordinal));
    map.set(batch.doc.id, list);
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      if (options.signal.aborted) return;
      if (timeUp?.aborted) {
        result.timedOut = true;
        return;
      }
      options.onBatchStart?.(batch, index, batches.length);

      let done = false;
      for (let attempt = 0; attempt < ATTEMPTS && !done; attempt++) {
        try {
          const outcome = await runBatch(batch, batchOptions);
          result.excerpts.push(...outcome.excerpts);
          if (outcome.uncertain) result.uncertain.push(batch);
          record(result.read, batch);
          done = true;
        } catch (error) {
          if (options.signal.aborted) throw error;
          // Out of time part-way through this batch: it stays unread, which is not a failure.
          if (timeUp?.aborted) {
            result.timedOut = true;
            return;
          }
          if (isAbort(error, options.signal)) throw error;
          if (attempt === ATTEMPTS - 1) {
            console.error(`[scan] batch ${index + 1}/${batches.length} failed:`, error);
            record(result.failed, batch);
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, worker));

  // Document order, without the duplicates that overlapping chunks produce.
  const order = new Map(options.docs.map((d, i) => [d.id, i]));
  result.excerpts.sort((a, b) => order.get(a.documentId)! - order.get(b.documentId)! || a.start - b.start);
  const unique: FoundExcerpt[] = [];
  for (const excerpt of result.excerpts) {
    const last = unique[unique.length - 1];
    if (last && last.documentId === excerpt.documentId && excerpt.start < last.end) {
      if (excerpt.end > last.end) {
        // Overlapping passages are merged into one.
        const doc = options.docs.find((d) => d.id === excerpt.documentId)!;
        last.end = excerpt.end;
        last.text = displaySlice(doc.verifiable.text, last);
        if (excerpt.note && !last.note.includes(excerpt.note)) last.note = [last.note, excerpt.note].filter(Boolean).join("; ");
      }
      continue;
    }
    unique.push(excerpt);
  }
  result.excerpts = unique.slice(0, MAX_EXCERPTS);
  return result;
}
