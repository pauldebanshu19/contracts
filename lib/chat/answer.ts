import { config, promptTokenBudget } from "../config";
import type { LoadedDocument } from "../documents/content";
import { pageAt, toStoredMatch } from "../documents/content";
import { LlmError, LlmToolsUnsupportedError, estimateRequestTokens, estimateTokens, isAbort, type ChatMessage } from "../llm/types";
import type { AnswerMode, Coverage } from "../types";
import { verifyCitation, type CitationDoc } from "../verify/citation";
import { runResearch } from "./agent";
import { fitHistory, takeWithin } from "./budget";
import type { ChunkRow } from "./chunks";
import { CoverageTracker, formatRanges, type CoverageDoc } from "./coverage";
import {
  FORMAT_REMINDER,
  answerSystemPrompt,
  documentBlock,
  historyMessages,
  reduceUserPrompt,
  shownSummary,
} from "./prompts";
import { allOf, scanInto, type AnswerContext, type AnswerSettings, type ModeResult, type Run, type RunDoc } from "./run";
import { streamModel, type VerifyFn } from "./stream";



const TARGETED_CHUNKS = 8;
const MAX_TARGETED_TOTAL = 16;


const EXHAUSTIVE = new RegExp(
  [
    "\\b(every|all|any|each|anywhere|nowhere|entire|whole|throughout)\\b",
    "\\b(list|enumerate|summari[sz]e|identify)\\b.*\\b(clauses?|obligations?|provisions?|rights|terms|references|mentions|instances|deadlines|dates|parties|payments|fees)\\b",
    "\\bhow many\\b",
    "\\b(is|are|was|were) there\\b",
    "\\bdoes\\b.*\\b(contain|include|have|mention|say anything|address|cover|provide for|deal with|refer)\\b",
    "\\b(do|does|did)(n't| not)\\b.*\\b(contain|include|have|mention|address|cover)\\b",
    "\\bwhether\\b",
    "\\b(missing|absent|silent|omit(s|ted)?|lacks?)\\b",
    "\\bno\\s+[\\w-]+\\s+(clause|provision|obligation)\\b",
  ].join("|"),
  "i",
);

export function needsFullScan(question: string): boolean {
  return EXHAUSTIVE.test(question);
}

function sizeLabel(doc: LoadedDocument): string {
  return doc.kind === "pdf" && doc.pageCount ? `${doc.pageCount}-page` : `${doc.chunkCount}-section`;
}

function makeVerifier(docs: RunDoc[], tracker: CoverageTracker): VerifyFn {
  return (alias, quote) => {
    // Rebuilt per quote: the ranges the model has been given grow as it reads.
    const candidates: CitationDoc[] = docs.map((d) => ({
      id: d.id,
      alias: d.alias,
      name: d.name,
      doc: d.loaded.verifiable,
      preferred: tracker.preferred(d.id),
    }));
    const result = verifyCitation(alias, quote, candidates);
    const target = docs.find((d) => d.id === result.documentId);
    const matches = target
      ? result.matches.map((m) => toStoredMatch(m, target.loaded.pages, target.loaded.verifiable.text))
      : [];
    const primary = matches[result.primary];
    return {
      documentId: result.documentId,
      alias: result.alias,
      modelQuote: result.modelQuote,
      verified: result.verified,
      reason: result.reason ?? null,
      reasonText: result.reasonText ?? null,
      displayText: result.displayText,
      matches,
      primary: result.primary,
      page: primary && target ? (primary.segments[0]?.page ?? pageAt(target.loaded.pages, primary.start)) : null,
    };
  };
}

/** A follow-up like "And for the Customer?" has no search terms of its own. */
function retrievalQuery(ctx: AnswerContext): string {
  const question = ctx.question.trim();
  const previous = [...ctx.history].reverse().find((m) => m.role === "user")?.content;
  const short = question.split(/\s+/).length < 8;
  const continues = /^(and|what about|how about|also|same for|what if|then)\b/i.test(question);
  return previous && (short || continues) ? `${previous} ${question}` : question;
}

/** Best chunks per document, best first. */
async function retrieve(run: Run): Promise<Map<string, ChunkRow[]>> {
  const perDoc = Math.max(3, Math.min(TARGETED_CHUNKS, Math.ceil(MAX_TARGETED_TOTAL / run.docs.length)));
  const query = retrievalQuery(run.ctx);
  const ranked = new Map<string, ChunkRow[]>();

  
  await Promise.all(
    run.docs.map(async (doc) => {
      const hits = await run.ctx.chunks.search(doc.id, query, perDoc);
      const order: ChunkRow[] = [];
      const seen = new Set<number>();
      hits.forEach((hit, i) => {
        if (!seen.has(hit.ordinal)) order.push(doc.chunks[hit.ordinal] ?? hit);
        seen.add(hit.ordinal);
        // A strong hit that is one piece of a longer clause brings the next piece with it.
        const next = doc.chunks[hit.ordinal + 1];
        if (i < 3 && next && next.section === hit.section && !seen.has(next.ordinal) && seen.size < perDoc + 2) {
          order.push(next);
          seen.add(next.ordinal);
        }
      });
      ranked.set(doc.id, order);
    }),
  );
  return ranked;
}

/** Round-robin across documents, so the first picks cover every document. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

async function runTargeted(run: Run): Promise<ModeResult & { intercepted?: boolean }> {
  const { ctx, tracker } = run;
  const budget = run.settings.promptBudget;
  const history = fitHistory(ctx.history, budget * 0.2);
  const system = answerSystemPrompt(run.docs);

  // As many of the best chunks as fit in one request; the coverage line reports exactly these.
  const ranked = await retrieve(run);
  const fixed =
    estimateRequestTokens([{ role: "system", content: system }, ...historyMessages(history), { role: "user", content: ctx.question }]) +
    80 * run.docs.length;
  const fitted = takeWithin(
    interleave(run.docs.map((d) => ranked.get(d.id) ?? [])),
    (chunk) => estimateTokens(chunk.text) + 30,
    budget - fixed,
    run.docs.length,
  );
  const picked = new Map(run.docs.map((d) => [d.id, fitted.filter((c) => c.documentId === d.id).sort((a, b) => a.ordinal - b.ordinal)]));
  for (const doc of run.docs) tracker.markRead(doc.id, picked.get(doc.id)!.map((c) => c.ordinal));

  const context = run.docs
    .map((doc) => {
      const chunks = picked.get(doc.id)!;
      const summary = shownSummary(doc, chunks, tracker.isComplete(doc.id));
      return chunks.length ? `${summary}\n${documentBlock(doc, chunks)}` : summary;
    })
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...historyMessages(history),
    { role: "user", content: `${context}\n\nQuestion: ${ctx.question}` },
  ];

  const attempt = () =>
    streamModel({
      llm: ctx.llm,
      request: { messages, purpose: "answer" },
      writer: ctx.writer,
      verify: run.verify,
      signal: ctx.signal,
      // A "not found" from a partial read must not be shown; the caller reads everything instead.
      intercept: (status) => status === "not_found" && !tracker.isComplete(),
    });

  let result = await attempt();
  if (result.intercepted) return { status: "not_found", intercepted: true };
  if (result.aborted) return { status: result.status ?? "answered", aborted: true };


  if (result.status !== "not_found" && result.cites === 0 && ctx.writer.text_.trim()) {
    messages.push({ role: "assistant", content: result.raw }, { role: "user", content: FORMAT_REMINDER });
    ctx.writer.reset("targeted");
    result = await attempt();
    if (result.intercepted) return { status: "not_found", intercepted: true };
    if (result.aborted) return { status: result.status ?? "answered", aborted: true };
  }
  return { status: result.status ?? "answered" };
}

/** Told to the step that writes the answer, so it doesn't claim absence over pages nobody read. */
function unreadCaveats(run: Run): string[] {
  return run.tracker
    .build("full_scan")
    .documents.filter((d) => d.failed.length || d.unreadable.length)
    .map((d) => {
      const parts: string[] = [];
      if (d.failed.length) parts.push(`${d.unit}s ${formatRanges(d.failed)} could not be read`);
      if (d.unreadable.length) parts.push(`${d.unit}s ${formatRanges(d.unreadable)} have no readable text`);
      return `Note for ${d.alias}: ${parts.join(" and ")}. Do not claim that something is absent from that document; say which ${d.unit}s were not read.`;
    });
}

const TIME_LIMIT_NOTE = "Reading stopped at this server's time limit for one answer, before everything was read";

async function runFullScan(run: Run): Promise<ModeResult> {
  const { ctx, tracker } = run;
  const scan = await scanInto(run, run.docs, ctx.question);

  if (scan.excerpts.length === 0) {
    if (scan.uncertain.length) {
      // Something was flagged but couldn't be confirmed: that rules out a "not found".
      const pages = scan.uncertain.flatMap((b) => b.chunks.flatMap((c) => (c.pageFrom !== null && c.pageTo !== null ? [c.pageFrom, c.pageTo] : [])));
      const where = pages.length ? ` on pages ${Math.min(...pages)}–${Math.max(...pages)}` : "";
      ctx.writer.text(
        `A passage that may answer this was flagged${where}, but it couldn't be confirmed word for word, so this can't be answered with a verified quote, and it can't be said that the document is silent on it. Try asking about that part of the document directly.`,
      );
      return { status: "partial" };
    }
    if (tracker.isComplete()) {
      // Written by code, not the model: nothing was found in any batch, and every batch ran.
      ctx.writer.text(
        run.docs.length === 1
          ? `Not found after reading ${allOf(run.docs[0].loaded)}.`
          : `Not found in any of the ${run.docs.length} documents after reading all of each.`,
      );
      return { status: "not_found" };
    }
    if (scan.timedOut) {
      ctx.writer.text(
        "Nothing relevant was found in the part that was read (listed below). This server limits how long one answer may take, and that ran out before the rest could be read, so this is not a complete answer.",
      );
      return { status: "partial", extras: { note: TIME_LIMIT_NOTE } };
    }
    ctx.writer.text(
      "Nothing relevant was found in the parts that were read, but some parts could not be read (listed below), so this is not a complete answer.",
    );
    return { status: "partial" };
  }

  ctx.writer.status("Writing the answer…");
  const budget = run.settings.promptBudget;
  const history = fitHistory(ctx.history, budget * 0.15);
  const system = answerSystemPrompt(run.docs);
  const caveats = unreadCaveats(run);
  if (scan.timedOut) {
    caveats.push(
      "The time limit was reached before every part was read. Do not claim that something is absent or that a list is complete; say that the answer covers only the part that was read, and use <status>partial</status>.",
    );
  }
  const fixed = estimateRequestTokens([
    { role: "system", content: system },
    ...historyMessages(history),
    { role: "user", content: reduceUserPrompt(run.docs, [], ctx.question, caveats) },
  ]);
  // Passages in document order, as many as one request can carry. If some don't fit, the model and the reader are told.
  const kept = takeWithin(scan.excerpts, (e) => estimateTokens(`${e.label} ${e.text} ${e.note}`) + 25, budget - fixed - 200);
  let extras: ModeResult["extras"] = scan.timedOut ? { note: TIME_LIMIT_NOTE } : undefined;
  if (kept.length < scan.excerpts.length) {
    caveats.push(
      `Only ${kept.length} of the ${scan.excerpts.length} relevant passages that were found fit in this request. Say that the answer may be incomplete and use <status>partial</status>.`,
    );
    const fit = `${scan.excerpts.length} relevant passages were found, but only the first ${kept.length} fit in the model's request size limit, so this answer may be incomplete`;
    extras = { note: extras?.note ? `${extras.note}. ${fit}` : fit };
  }
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...historyMessages(history),
    { role: "user", content: reduceUserPrompt(run.docs, kept, ctx.question, caveats) },
  ];
  const result = await streamModel({
    llm: ctx.llm,
    request: { messages, purpose: "answer" },
    writer: ctx.writer,
    verify: run.verify,
    signal: ctx.signal,
  });
  const status = result.status ?? "answered";
  // An answer built from part of the document is never reported as the whole answer.
  return { status: scan.timedOut && status === "answered" ? "partial" : status, aborted: result.aborted, extras };
}

export async function answerQuestion(ctx: AnswerContext): Promise<void> {
  const c = config();
  const merged: AnswerSettings = {
    maxRounds: c.AGENT_MAX_ROUNDS,
    maxCallsPerRound: c.AGENT_MAX_CALLS_PER_ROUND,
    tokenBudget: c.QUESTION_TOKEN_BUDGET,
    scanConcurrency: c.SCAN_CONCURRENCY,
    scanBatchTokens: c.SCAN_BATCH_TOKENS,
    promptBudget: promptTokenBudget(),
    ...ctx.settings,
  };
  // A scan batch plus its instructions must fit in one request.
  const settings: AnswerSettings = {
    ...merged,
    scanBatchTokens: Math.max(400, Math.min(merged.scanBatchTokens, merged.promptBudget - 900)),
  };

  let tracker: CoverageTracker | undefined;
  let extras: Pick<Coverage, "escalated" | "stoppedAtLimit" | "note"> = {};
  const coverage = () => tracker?.build(ctx.writer.currentMode, extras) ?? null;

  try {
    const docs: RunDoc[] = await Promise.all(
      ctx.docs.map(async (doc) => ({ ...doc, sizeLabel: sizeLabel(doc.loaded), chunks: await ctx.chunks.all(doc.id) })),
    );
    const coverageDocs: CoverageDoc[] = docs.map((d) => ({
      id: d.id,
      alias: d.alias,
      name: d.name,
      kind: d.loaded.kind,
      pageCount: d.loaded.pageCount,
      unreadablePages: d.loaded.unreadablePages,
      pages: d.loaded.pages,
      chunks: d.chunks,
    }));
    tracker = new CoverageTracker(coverageDocs);
    const run: Run = { ctx, settings, docs, tracker, verify: makeVerifier(docs, tracker) };
    const everything = docs.length === 1 ? allOf(docs[0].loaded) : `all ${docs.length} documents`;

    let mode: AnswerMode = needsFullScan(ctx.question) ? "full_scan" : ctx.research ? "research" : "targeted";
    ctx.writer.setMode(mode);
    let result: ModeResult & { intercepted?: boolean };

    if (mode === "full_scan") {
      ctx.writer.status(`Reading ${everything}…`);
      result = await runFullScan(run);
    } else if (mode === "research") {
      try {
        result = await runResearch(run);
      } catch (error) {
        if (!(error instanceof LlmToolsUnsupportedError)) throw error;
        mode = "targeted";
        ctx.writer.reset("targeted");
        extras = { note: "Research mode isn't available with this model, so this answer used a single targeted search" };
        result = await runTargeted(run);
      }
    } else {
      result = await runTargeted(run);
    }
    extras = { ...extras, ...result.extras };

    // Rule 1: a "not found" from a partial read is replaced by a full read before anything is final.
    const stoppedEarly = () => Boolean(result.aborted) || ctx.signal.aborted;
    if (result.status === "not_found" && !stoppedEarly() && !tracker.isComplete() && mode !== "full_scan") {
      ctx.writer.reset("full_scan");
      ctx.writer.status(`Not found in ${mode === "research" ? "research" : "targeted search"}. Reading ${everything}…`);
      // The full read replaces the earlier attempt, including any limit it ran into.
      extras = { escalated: true, ...(extras.note ? { note: extras.note } : {}) };
      result = await runFullScan(run);
    }

    // Rule 2: with unread pages, absence can't be claimed.
    const status = result.status === "not_found" && !tracker.isComplete() ? "partial" : result.status;

    await ctx.writer.finish({
      status: stoppedEarly() ? "stopped" : "complete",
      answerStatus: stoppedEarly() ? null : status,
      coverage: coverage(),
    });
  } catch (error) {
    if (isAbort(error, ctx.signal)) {
      await ctx.writer.finish({ status: "stopped", answerStatus: null, coverage: coverage() });
      return;
    }
    console.error("[chat] answer failed:", error);
    const message =
      error instanceof LlmError ? error.message : "Something went wrong while answering. Any partial answer above was kept.";
    await ctx.writer.finish({ status: "error", answerStatus: null, coverage: coverage(), error: message });
  }
}
