import type { LoadedDocument } from "../documents/content";
import type { Llm } from "../llm/types";
import type { AnswerStatus, Coverage } from "../types";
import type { ChunkRow, ChunkStore } from "./chunks";
import type { CoverageTracker } from "./coverage";
import type { PromptDoc } from "./prompts";
import { scanDocuments, type ScanBatch, type ScanDoc, type ScanResult } from "./scan";
import type { VerifyFn } from "./stream";
import type { AnswerWriter } from "./writer";

/** What one question's run carries around, shared by the targeted, full-scan and research modes. */

export interface AnswerDoc {
  id: string;
  alias: string;
  name: string;
  loaded: LoadedDocument;
}

export interface AnswerSettings {
  maxRounds: number;
  maxCallsPerRound: number;
  tokenBudget: number;
  scanConcurrency: number;
  scanBatchTokens: number;
  /** Largest prompt one request may carry (Infinity when the provider sets no limit). */
  promptBudget: number;
}

export interface AnswerContext {
  docs: AnswerDoc[];
  question: string;
  /** Earlier turns, oldest first, already trimmed to the last few. */
  history: { role: "user" | "assistant"; content: string }[];
  llm: Llm;
  chunks: ChunkStore;
  writer: AnswerWriter;
  signal: AbortSignal;
  /** Use the tool-using research loop for questions that don't need a full scan. */
  research: boolean;
  settings?: Partial<AnswerSettings>;
}

export interface RunDoc extends AnswerDoc, PromptDoc {
  chunks: ChunkRow[];
}

export interface Run {
  ctx: AnswerContext;
  settings: AnswerSettings;
  docs: RunDoc[];
  tracker: CoverageTracker;
  verify: VerifyFn;
}

export interface ModeResult {
  status: AnswerStatus;
  aborted?: boolean;
  extras?: Pick<Coverage, "stoppedAtLimit" | "note">;
}

/** "all 150 pages" / "all 42 sections" / "all 147 readable pages". */
export function allOf(doc: LoadedDocument): string {
  if (doc.kind !== "pdf" || !doc.pageCount) return `all ${doc.chunkCount} sections`;
  const readable = doc.pageCount - doc.unreadablePages.length;
  return doc.unreadablePages.length ? `all ${readable} readable pages` : `all ${doc.pageCount} pages`;
}

function batchLabel(batch: ScanBatch, many: boolean): string {
  const first = batch.chunks[0];
  const last = batch.chunks[batch.chunks.length - 1];
  const prefix = many ? `${batch.doc.name}: ` : "";
  if (first.pageFrom !== null && last.pageTo !== null) {
    return first.pageFrom === last.pageTo
      ? `${prefix}Reading page ${first.pageFrom}…`
      : `${prefix}Reading pages ${first.pageFrom}–${last.pageTo}…`;
  }
  return `${prefix}Reading sections ${first.ordinal + 1}–${last.ordinal + 1}…`;
}

export async function scanInto(run: Run, docs: RunDoc[], question: string): Promise<ScanResult> {
  const { ctx, tracker, settings } = run;
  const scanDocs: ScanDoc[] = docs.map((d) => ({
    id: d.id,
    alias: d.alias,
    name: d.name,
    sizeLabel: d.sizeLabel,
    verifiable: d.loaded.verifiable,
    chunks: d.chunks,
  }));
  const scan = await scanDocuments({
    docs: scanDocs,
    question,
    llm: ctx.llm,
    signal: ctx.signal,
    concurrency: settings.scanConcurrency,
    batchTokens: settings.scanBatchTokens,
    onBatchStart: (batch) => ctx.writer.status(batchLabel(batch, run.docs.length > 1)),
  });
  for (const [id, ordinals] of scan.read) tracker.markRead(id, ordinals);
  for (const [id, ordinals] of scan.failed) tracker.markFailed(id, ordinals);
  // The model is about to quote from these passages, so that is where its quotes should open.
  for (const excerpt of scan.excerpts) tracker.markSeen(excerpt.documentId, excerpt);
  return scan;
}
