import { eq } from "drizzle-orm";
import { llmConfigured, promptTokenBudget } from "../config";
import { db, schema } from "../db";
import { loadDocument } from "../documents/content";
import { getLlm } from "../llm/openai";
import { LlmError } from "../llm/types";
import { alignClauses, toVersionClauses } from "./align";
import { significanceFloor } from "./significance";
import { batches, guessCategory, overallSummary, ruleSummary, summariseBatch, summaryBatches, topChanges, type Change } from "./summarise";



const { comparisons, comparisonChanges } = schema;

/** Time kept back, on a host with a request time limit, for saving the result. */
const SAVE_RESERVE_MS = 25_000;

async function setStage(id: string, stage: string) {
  await db().update(comparisons).set({ stage }).where(eq(comparisons.id, id));
}

export async function runComparison(id: string, heartbeat: () => Promise<void>, deadline?: number): Promise<void> {
  const [row] = await db().select().from(comparisons).where(eq(comparisons.id, id));
  if (!row) return;
  await db().update(comparisons).set({ status: "processing", error: null, notice: null }).where(eq(comparisons.id, id));
  await setStage(id, "Aligning clauses");

  const [a, b] = await Promise.all([loadDocument(row.docA), loadDocument(row.docB)]);
  if (!a || !b) throw new Error("Both documents must be processed before they can be compared.");

  const pairs = alignClauses(
    toVersionClauses(a.verifiable.text, a.clauses),
    toVersionClauses(b.verifiable.text, b.clauses),
  );

  // Identical clauses never appear in the list (B3.3).
  const changes: Change[] = pairs
    .filter((pair) => pair.type !== "unchanged")
    .map((pair, id) => {
      const floor = significanceFloor(pair);
      return { id, pair, floor, summary: ruleSummary(pair, floor), category: guessCategory(pair), significance: floor.floor };
    });

  let notice: string | null = null;
  let summary: string[] = [];
  // Cosmetic changes are decided by rules alone: no model call (B3.4).
  const forModel = changes.filter((c) => c.floor.floor !== "cosmetic");

  if (!llmConfigured()) {
    notice = "No model is configured, so changes are ranked by rules only and summaries are generated from the text.";
  } else if (forModel.length) {
    const llm = getLlm();
    const groups = summaryBatches(forModel, promptTokenBudget());
    // With a time limit, whatever the model hasn't summarised by then keeps its rule-based summary and rank.
    const timeUp = deadline === undefined ? undefined : AbortSignal.timeout(Math.max(0, deadline - Date.now() - SAVE_RESERVE_MS));
    let failed = 0;
    let unreached = 0;
    let done = 0;
    for (const group of groups) {
      if (timeUp?.aborted) {
        unreached += group.length;
        continue;
      }
      await setStage(id, `Summarising changes ${done + 1}–${done + group.length} of ${forModel.length}`);
      done += group.length;
      await heartbeat();
      try {
        await summariseBatch(llm, group, timeUp);
      } catch (error) {
        if (timeUp?.aborted) {
          unreached += group.length;
          continue;
        }
        failed += group.length;
        console.error("[compare] batch failed:", error);
      }
    }
    const notices: string[] = [];
    if (failed) notices.push(`${failed} of ${forModel.length} changes could not be summarised by the model; they show rule-based summaries and ranks.`);
    if (unreached) {
      notices.push(
        `${unreached} of ${forModel.length} changes show rule-based summaries and ranks: this server's time limit for one comparison ran out before the model reached them.`,
      );
    }
    if (notices.length) notice = notices.join(" ");

    if (!timeUp?.aborted) {
      await setStage(id, "Writing the summary");
      try {
        summary = await overallSummary(llm, changes, timeUp);
      } catch (error) {
        if (!timeUp?.aborted) {
          console.error("[compare] summary failed:", error);
          notice ??= error instanceof LlmError ? error.message : "The overall summary couldn't be written.";
        }
      }
    }
  }
  if (!summary.length) summary = topChanges(changes).map((c) => c.summary);

  await db().transaction(async (tx) => {
    await tx.delete(comparisonChanges).where(eq(comparisonChanges.comparisonId, id));
    for (const group of batches(changes, 200)) {
      await tx.insert(comparisonChanges).values(
        group.map((c) => ({
          comparisonId: id,
          ordinal: c.id,
          type: c.pair.type === "unchanged" ? "cosmetic" : c.pair.type,
          significance: c.significance,
          floor: c.floor.floor,
          floorReasons: c.floor.reasons,
          category: c.category,
          summary: c.summary,
          aNumber: c.pair.a?.number ?? null,
          aHeading: c.pair.a?.heading ?? null,
          aStart: c.pair.a?.start ?? null,
          aEnd: c.pair.a?.end ?? null,
          bNumber: c.pair.b?.number ?? null,
          bHeading: c.pair.b?.heading ?? null,
          bStart: c.pair.b?.start ?? null,
          bEnd: c.pair.b?.end ?? null,
        })),
      );
    }
    await tx.update(comparisons).set({ status: "ready", stage: null, summary, notice }).where(eq(comparisons.id, id));
  });
}

export async function failComparison(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error && /processed/.test(error.message) ? error.message : "The comparison failed. Try again.";
  await db().update(comparisons).set({ status: "failed", stage: null, error: message }).where(eq(comparisons.id, id));
}
