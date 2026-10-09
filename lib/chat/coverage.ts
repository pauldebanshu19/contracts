import type { Segment } from "../text/normalize";
import type { AnswerMode, Coverage, DocCoverage } from "../types";

/**
 * What the model was actually given, tracked in code (PRD A4.3). The coverage
 * line under an answer and the right to say "not in the document" both come
 * from this record, never from what the model says it read.
 */

export interface ChunkRef extends Segment {
  ordinal: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface CoverageDoc {
  id: string;
  alias: string;
  name: string;
  kind: "pdf" | "docx";
  pageCount: number | null;
  unreadablePages: number[];
  /** Text range of each page, PDFs only. */
  pages: Segment[];
  chunks: ChunkRef[];
}

interface DocState {
  doc: CoverageDoc;
  read: Set<number>;
  failed: Set<number>;
  /** Ranges returned in full that don't line up with chunks (a section, a few pages). */
  ranges: Segment[];
  /** Ranges the model saw only a snippet of. Used to pick which occurrence to open, never counted as read. */
  seen: Segment[];
}

export class CoverageTracker {
  private readonly states = new Map<string, DocState>();

  constructor(docs: CoverageDoc[]) {
    for (const doc of docs) this.states.set(doc.id, { doc, read: new Set(), failed: new Set(), ranges: [], seen: [] });
  }

  private state(documentId: string): DocState {
    const state = this.states.get(documentId);
    if (!state) throw new Error(`Unknown document ${documentId}`);
    return state;
  }

  /** The full text of these chunks was sent to the model. */
  markRead(documentId: string, ordinals: Iterable<number>): void {
    const state = this.state(documentId);
    for (const ordinal of ordinals) {
      state.read.add(ordinal);
      state.failed.delete(ordinal);
    }
  }

  /** These chunks should have been read by a step that failed. */
  markFailed(documentId: string, ordinals: Iterable<number>): void {
    const state = this.state(documentId);
    for (const ordinal of ordinals) if (!state.read.has(ordinal)) state.failed.add(ordinal);
  }

  /** A text range was sent in full, e.g. one section or the pages returned by get_pages. */
  markRange(documentId: string, range: Segment): void {
    const state = this.state(documentId);
    for (const chunk of state.doc.chunks) {
      // Only chunks wholly inside the range count towards having read the whole document.
      if (chunk.start >= range.start && chunk.end <= range.end) {
        state.read.add(chunk.ordinal);
        state.failed.delete(chunk.ordinal);
      }
    }
    state.ranges.push(range);
  }

  markSeen(documentId: string, range: Segment): void {
    this.state(documentId).seen.push(range);
  }

  /** Text ranges the model was given from this document: where a quote most likely came from. */
  preferred(documentId: string): Segment[] {
    const state = this.state(documentId);
    const ranges = state.doc.chunks.filter((c) => state.read.has(c.ordinal)).map((c) => ({ start: c.start, end: c.end }));
    return [...ranges, ...state.ranges, ...state.seen];
  }

  isComplete(documentId?: string): boolean {
    const states = documentId ? [this.state(documentId)] : [...this.states.values()];
    return states.every((s) => s.failed.size === 0 && s.doc.chunks.every((c) => s.read.has(c.ordinal)));
  }

  unread(documentId: string): number[] {
    const state = this.state(documentId);
    return state.doc.chunks.filter((c) => !state.read.has(c.ordinal)).map((c) => c.ordinal);
  }

  build(mode: AnswerMode, extras: Pick<Coverage, "escalated" | "stoppedAtLimit" | "note"> = {}): Coverage {
    const documents: DocCoverage[] = [...this.states.values()].map(({ doc, read, failed, ranges }) => {
      const base = { documentId: doc.id, alias: doc.alias, name: doc.name };
      if (doc.kind !== "pdf" || !doc.pageCount) {
        return {
          ...base,
          unit: "section" as const,
          total: doc.chunks.length,
          read: [...read].map((o) => o + 1).sort((a, b) => a - b),
          unreadable: [],
          failed: [...failed].map((o) => o + 1).sort((a, b) => a - b),
        };
      }

      const unreadable = new Set(doc.unreadablePages);
      const pagesOf = (ordinals: Set<number>) => {
        const pages = new Set<number>();
        for (const chunk of doc.chunks) {
          if (!ordinals.has(chunk.ordinal) || chunk.pageFrom === null || chunk.pageTo === null) continue;
          for (let p = chunk.pageFrom; p <= chunk.pageTo; p++) if (!unreadable.has(p)) pages.add(p);
        }
        return pages;
      };
      const readPages = pagesOf(read);
      for (const range of ranges) {
        doc.pages.forEach((page, i) => {
          if (page.end > range.start && page.start < range.end && !unreadable.has(i + 1)) readPages.add(i + 1);
        });
      }
      // A page shared by a read chunk and a failed one was only partly read, so it counts as not read.
      const failedPages = pagesOf(failed);
      for (const page of failedPages) readPages.delete(page);

      return {
        ...base,
        unit: "page" as const,
        total: doc.pageCount,
        read: [...readPages].sort((a, b) => a - b),
        unreadable: [...unreadable].sort((a, b) => a - b),
        failed: [...failedPages].sort((a, b) => a - b),
      };
    });

    return { mode, documents, complete: this.isComplete(), ...extras };
  }
}

/** [41, 42, 43, 50] becomes "41–43, 50". */
export function formatRanges(numbers: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(i === j ? `${numbers[i]}` : `${numbers[i]}–${numbers[j]}`);
    i = j;
  }
  return parts.join(", ");
}

const MODE_LABEL: Record<AnswerMode, string> = {
  targeted: "targeted search",
  full_scan: "full scan",
  research: "research",
};

function plural(count: number, unit: "page" | "section"): string {
  return count === 1 ? unit : `${unit}s`;
}

function readPhrase(doc: DocCoverage, complete: boolean, capital: boolean): string {
  const readable = doc.total - doc.unreadable.length;
  if (complete && doc.read.length >= readable) {
    const all = doc.unreadable.length ? `all ${readable} readable` : `all ${doc.total}`;
    return `${capital ? "Read " : ""}${all} ${plural(doc.total, doc.unit)}`;
  }
  return `${capital ? "Read " : ""}${doc.read.length} of ${doc.total} ${plural(doc.total, doc.unit)}`;
}

/**
 * The lines shown under an answer, e.g. "Read 9 of 150 pages (targeted search)"
 * or "Lease A: all 40 pages · Lease B: 12 of 90 pages" (PRD A4.3, B2.7).
 */
export function formatCoverage(coverage: Coverage): string[] {
  const lines: string[] = [];
  const many = coverage.documents.length > 1;
  const docComplete = (doc: DocCoverage) => doc.failed.length === 0 && doc.read.length >= doc.total - doc.unreadable.length;

  const main = many
    ? coverage.documents.map((doc) => `${doc.name}: ${readPhrase(doc, docComplete(doc), false)}`).join(" · ")
    : coverage.documents.map((doc) => readPhrase(doc, coverage.complete && docComplete(doc), true)).join("");
  lines.push(`${main} (${MODE_LABEL[coverage.mode]})`);

  for (const doc of coverage.documents) {
    const prefix = many ? `${doc.name}: ` : "";
    const Unit = doc.unit === "page" ? "Page" : "Section";
    if (doc.unreadable.length) {
      const one = doc.unreadable.length === 1;
      lines.push(
        `${prefix}${Unit}${one ? "" : "s"} ${formatRanges(doc.unreadable)} ${one ? "has" : "have"} no readable text and ${one ? "was" : "were"} not read`,
      );
    }
    if (doc.failed.length) {
      const one = doc.failed.length === 1;
      lines.push(`${prefix}${Unit}${one ? "" : "s"} ${formatRanges(doc.failed)} could not be read, so this answer can't rule ${one ? "it" : "them"} out`);
    }
  }
  if (coverage.escalated) lines.push("Nothing was found in a targeted search, so the whole document was read");
  if (coverage.stoppedAtLimit) lines.push("Research stopped at its step limit before it finished");
  if (coverage.note) lines.push(coverage.note);
  return lines;
}
