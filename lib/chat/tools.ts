import { z } from "zod";
import type { ToolCall, ToolDefinition } from "../llm/types";
import type { Segment } from "../text/normalize";
import { sectionLabel, type Clause } from "../text/segment";
import { displaySlice } from "../verify/quote";
import { expandQuery } from "./chunks";
import { formatRanges } from "./coverage";
import { chunkLabel } from "./prompts";
import { scanInto, type Run, type RunDoc } from "./run";



const SNIPPET_CHARS = 400;
const MAX_OUTLINE_LINES = 250;

export interface ToolOutcome {
  /** Text returned to the model. */
  content: string;
  /** False for unknown tools, bad arguments, things that don't exist, and repeats. */
  ok: boolean;
  /** The line shown in the live step list. */
  label: string;
  detail?: string;
}

const docArg = z.string().min(1).describe("Document alias, for example D1");

const schemas = {
  list_clauses: z.object({ doc: docArg }),
  search_document: z.object({
    doc: docArg,
    query: z.string().min(2).describe("Words likely to appear in the contract"),
    limit: z.number().int().min(1).max(8).optional().describe("Number of hits, at most 8 (default 5)"),
  }),
  get_section: z.object({
    doc: docArg,
    section: z.string().min(1).describe('Section number from the outline such as "14.2", or a chunk id from search results such as "c37"'),
    part: z.number().int().min(1).optional().describe("Which part of a long section (default 1)"),
  }),
  get_pages: z
    .object({
      doc: docArg,
      from: z.number().int().min(1).describe("First page"),
      to: z.number().int().min(1).describe("Last page; at most 3 pages per call"),
    })
    .refine((v) => v.to >= v.from, { message: "to must not be before from", path: ["to"] })
    .refine((v) => v.to - v.from <= 2, { message: "at most 3 pages per call", path: ["to"] }),
  scan_document: z.object({
    doc: docArg,
    question: z.string().min(3).describe("What to look for across the whole document"),
  }),
};

type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  list_clauses: "Outline of a document: section numbers, headings and page ranges. Use it first to see how the contract is organised.",
  search_document: "Keyword search across the whole document. Returns short snippets with the section and a chunk id. Read the section before relying on a snippet.",
  get_section: "Full text of one section (including its sub-clauses), by section number or chunk id. Long sections come in parts.",
  get_pages: "Raw text of up to 3 consecutive pages. PDFs only.",
  scan_document: "Reads every part of the document for a question and returns all relevant passages. Slow; use it for 'every', 'any' or 'is there' questions, and before saying something is absent. Once per document.",
};

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(schemas) as ToolName[]).map((name) => {
    const parameters = z.toJSONSchema(schemas[name]) as Record<string, unknown>;
    delete parameters.$schema;
    return { name, description: descriptions[name], parameters };
  });
}

function pageSpan(from: number | null, to: number | null): string {
  if (from === null || to === null) return "";
  return from === to ? `p. ${from}` : `p. ${from}–${to}`;
}

function clausePages(doc: RunDoc, range: Segment): string {
  const pages = doc.loaded.pages;
  if (!pages.length) return "";
  let from: number | null = null;
  let to: number | null = null;
  pages.forEach((page, i) => {
    if (page.end > range.start && page.start < range.end) {
      from ??= i + 1;
      to = i + 1;
    }
  });
  return pageSpan(from, to);
}

function withPages(label: string, pages: string): string {
  return pages ? `${label} (${pages})` : label;
}

/** State for one question's research. */
export class ToolRunner {
  private readonly made = new Set<string>();
  private readonly scanned = new Set<string>();
  /** Long sections come back in parts of this many characters. */
  private readonly partChars: number;

  /** `maxChars` caps every tool result, so results fit within the model's request size. */
  constructor(
    private readonly run: Run,
    private readonly maxChars = 9000,
  ) {
    this.partChars = Math.max(1500, Math.min(6000, maxChars - 400));
  }

  private truncate(text: string): string {
    return text.length > this.maxChars ? `${text.slice(0, this.maxChars)}\n[truncated]` : text;
  }

  /** Called when earlier results were dropped to fit a request: repeating a call is then legitimate. */
  allowRepeats(): void {
    this.made.clear();
  }

  private resolveDoc(alias: string): RunDoc | string {
    const wanted = alias.trim().toUpperCase();
    const doc =
      this.run.docs.find((d) => d.alias.toUpperCase() === wanted) ??
      this.run.docs.find((d) => d.name.trim().toUpperCase() === wanted);
    if (doc) return doc;
    const available = this.run.docs.map((d) => `${d.alias} ("${d.name}")`).join(", ");
    return `Document "${alias}" is not in this chat. Available: ${available}.`;
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    const names = Object.keys(schemas) as ToolName[];
    if (!names.includes(call.name as ToolName)) {
      return {
        ok: false,
        label: `Unknown tool ${call.name}`,
        content: `Unknown tool \`${call.name}\`. Available: ${names.join(", ")}.`,
      };
    }
    const name = call.name as ToolName;

    let raw: unknown;
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      return {
        ok: false,
        label: `${name}: arguments weren't valid JSON`,
        content: `The arguments for ${name} were not valid JSON. Send a JSON object, for example {"doc": "${this.run.docs[0].alias}"}.`,
      };
    }
    // With one document, a missing alias can only mean that document.
    if (this.run.docs.length === 1 && raw && typeof raw === "object" && !("doc" in raw)) {
      (raw as Record<string, unknown>).doc = this.run.docs[0].alias;
    }

    const parsed = schemas[name].safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
      return { ok: false, label: `${name}: invalid arguments`, content: `Invalid arguments for ${name}. ${problems}. Fix them and call again.` };
    }

    const key = `${name}:${JSON.stringify(parsed.data, Object.keys(parsed.data).sort())}`;
    if (this.made.has(key)) {
      return {
        ok: false,
        label: `${name}: repeated call`,
        content: "You already made this exact call and its result was already returned above. Do not repeat it: use that result, try something different, or write the answer.",
      };
    }
    this.made.add(key);

    const doc = this.resolveDoc(parsed.data.doc);
    if (typeof doc === "string") return { ok: false, label: `${name}: unknown document`, content: doc };

    try {
      switch (name) {
        case "list_clauses":
          return this.listClauses(doc);
        case "search_document":
          return await this.search(doc, parsed.data as z.infer<typeof schemas.search_document>);
        case "get_section":
          return this.getSection(doc, parsed.data as z.infer<typeof schemas.get_section>);
        case "get_pages":
          return this.getPages(doc, parsed.data as z.infer<typeof schemas.get_pages>);
        case "scan_document":
          return await this.scan(doc, parsed.data as z.infer<typeof schemas.scan_document>);
      }
    } catch (error) {
      if (this.run.ctx.signal.aborted) throw error;
      console.error(`[agent] ${name} threw:`, error);
      return { ok: false, label: `${name} failed`, content: `The ${name} tool failed with an internal error. Try a different approach.` };
    }
  }

  private listClauses(doc: RunDoc): ToolOutcome {
    const clauses = doc.loaded.clauses.filter((c) => c.number || c.heading);
    if (clauses.length <= 1) {
      return {
        ok: true,
        label: `Listing clauses of ${doc.name}: no headings found`,
        content: `No section headings were detected in ${doc.alias}. Use search_document${doc.loaded.pages.length ? " or get_pages" : ""} instead.`,
      };
    }
    // A very long outline is cut to its upper levels.
    let shown = clauses;
    for (let depth = 6; shown.length > MAX_OUTLINE_LINES && depth >= 1; depth--) shown = clauses.filter((c) => c.depth <= depth);
    shown = shown.slice(0, MAX_OUTLINE_LINES);

    const lines = shown.map((c) => `${"  ".repeat(Math.min(c.depth - 1, 3))}${withPages(sectionLabel(c.number, c.heading), clausePages(doc, c))}`);
    const note = shown.length < clauses.length ? `\n(${clauses.length - shown.length} deeper sub-clauses not listed.)` : "";
    return {
      ok: true,
      label: `Listing clauses of ${doc.name}`,
      detail: `${clauses.length} sections`,
      content: this.truncate(`Outline of ${doc.alias} ("${doc.name}"):\n${lines.join("\n")}${note}`),
    };
  }

  private snippet(text: string, query: string): Segment {
    const words = expandQuery(query).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    const lower = text.toLowerCase();
    let at = -1;
    for (const word of words) {
      // Stems catch "terminate" for "termination".
      const hit = lower.indexOf(word.slice(0, Math.max(4, word.length - 3)));
      if (hit !== -1 && (at === -1 || hit < at)) at = hit;
    }
    const start = Math.max(0, (at === -1 ? 0 : at) - 100);
    return { start, end: Math.min(text.length, start + SNIPPET_CHARS) };
  }

  private async search(doc: RunDoc, args: { query: string; limit?: number }): Promise<ToolOutcome> {
    const hits = await this.run.ctx.chunks.search(doc.id, args.query, args.limit ?? 5);
    if (!hits.length) {
      return {
        ok: true,
        label: `Searching “${args.query}”: no hits`,
        content: `No matches for "${args.query}" in ${doc.alias}. Try other words the contract might use, list_clauses, or scan_document.`,
      };
    }
    const lines = hits.map((hit) => {
      const local = this.snippet(hit.text, args.query);
      const range = { start: hit.start + local.start, end: hit.start + local.end };
      this.run.tracker.markSeen(doc.id, range);
      const text = displaySlice(doc.loaded.verifiable.text, range);
      return `[c${hit.ordinal}] ${withPages(chunkLabel(hit), pageSpan(hit.pageFrom, hit.pageTo))}\n  …${text}…`;
    });
    const sections = [...new Set(hits.map((h) => (h.section ? sectionLabel(h.section, "") : h.heading || `c${h.ordinal}`)))];
    return {
      ok: true,
      label: `Searching “${args.query}”: ${hits.length} ${hits.length === 1 ? "hit" : "hits"} in ${sections.slice(0, 4).join(", ")}${sections.length > 4 ? "…" : ""}`,
      content: this.truncate(`${hits.length} hits in ${doc.alias} for "${args.query}" (snippets only; use get_section with the chunk id to read one):\n${lines.join("\n")}`),
    };
  }

  /** The text range of a clause together with its sub-clauses. */
  private clauseRange(doc: RunDoc, index: number): Segment {
    const clauses = doc.loaded.clauses;
    const clause = clauses[index];
    let end = clause.end;
    for (let i = index + 1; i < clauses.length; i++) {
      const next = clauses[i];
      const child = clause.number && /^\d/.test(clause.number) ? next.number.startsWith(`${clause.number}.`) : next.depth > clause.depth;
      if (!child) break;
      end = next.end;
    }
    return { start: clause.start, end };
  }

  private findClause(doc: RunDoc, wanted: string): number {
    const clean = (s: string) => s.toLowerCase().replace(/^§\s*/, "").replace(/^(section|clause|sec\.?|cl\.?)\s+/, "").replace(/[.\s]+$/, "").trim();
    const target = clean(wanted);
    const clauses = doc.loaded.clauses;
    let best = -1;
    clauses.forEach((clause, i) => {
      if (!clause.number || clean(clause.number) !== target) return;
      // A table of contents repeats every number; the real clause is the longer one.
      if (best === -1 || clause.end - clause.start > clauses[best].end - clauses[best].start) best = i;
    });
    if (best !== -1) return best;
    // Fall back to a heading match: "Termination" finds "14 Termination".
    return clauses.findIndex((c) => c.heading && c.heading.toLowerCase() === target);
  }

  private nearest(doc: RunDoc, wanted: string): string {
    const numbered = doc.loaded.clauses.filter((c) => c.number);
    if (!numbered.length) return "This document has no numbered sections; use a chunk id from search_document.";
    const target = wanted.replace(/^[^\dA-Za-z]+/, "");
    const shared = (a: string) => {
      let n = 0;
      while (n < a.length && n < target.length && a[n].toLowerCase() === target[n].toLowerCase()) n++;
      return n;
    };
    const ranked = [...numbered].sort((a, b) => shared(b.number) - shared(a.number)).slice(0, 8);
    return `Nearest sections: ${ranked.map((c) => sectionLabel(c.number, c.heading)).join("; ")}.`;
  }

  private getSection(doc: RunDoc, args: { section: string; part?: number }): ToolOutcome {
    let range: Segment;
    let label: string;

    const chunkId = /^c(\d+)$/i.exec(args.section.trim());
    if (chunkId) {
      const chunk = doc.chunks[Number(chunkId[1])];
      if (!chunk) {
        return {
          ok: false,
          label: `Reading ${args.section}: no such chunk`,
          content: `Chunk ${args.section} doesn't exist in ${doc.alias}. Chunk ids run from c0 to c${doc.chunks.length - 1}.`,
        };
      }
      range = { start: chunk.start, end: chunk.end };
      label = chunkLabel(chunk);
    } else {
      const index = this.findClause(doc, args.section);
      if (index === -1) {
        return {
          ok: false,
          label: `Reading ${args.section}: no such section`,
          content: `Section "${args.section}" doesn't exist in ${doc.alias}. ${this.nearest(doc, args.section)}`,
        };
      }
      const clause: Clause = doc.loaded.clauses[index];
      range = this.clauseRange(doc, index);
      label = sectionLabel(clause.number, clause.heading);
    }

    // Long sections are returned in parts, cut at a line or sentence end.
    const text = doc.loaded.verifiable.text;
    const parts: Segment[] = [];
    for (let start = range.start; start < range.end; ) {
      let end = Math.min(range.end, start + this.partChars);
      if (end < range.end) {
        const slice = text.slice(start, end);
        const cut = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". ") + 1);
        if (cut > this.partChars / 2) end = start + cut + 1;
      }
      parts.push({ start, end });
      start = end;
    }
    const part = args.part ?? 1;
    if (part > parts.length) {
      return {
        ok: false,
        label: `Reading ${label}: no part ${part}`,
        content: `${label} has only ${parts.length} ${parts.length === 1 ? "part" : "parts"}.`,
      };
    }

    const piece = parts[part - 1];
    this.run.tracker.markRange(doc.id, piece);
    const pages = clausePages(doc, piece);
    const of = parts.length > 1 ? `, part ${part} of ${parts.length}` : "";
    const more = part < parts.length ? `\n[Continues in part ${part + 1}: call get_section again with part=${part + 1}.]` : "";
    return {
      ok: true,
      label: `Reading ${withPages(label, pages)}${of}`,
      content: `${doc.alias} ${withPages(label, pages)}${of}:\n${text.slice(piece.start, piece.end).trim()}${more}`,
    };
  }

  private getPages(doc: RunDoc, args: { from: number; to: number }): ToolOutcome {
    const pages = doc.loaded.pages;
    if (!pages.length) {
      return {
        ok: false,
        label: `Reading pages of ${doc.name}: not a PDF`,
        content: `${doc.alias} is a Word document with no fixed pages. Use get_section or search_document.`,
      };
    }
    if (args.to > pages.length) {
      return {
        ok: false,
        label: `Reading pages ${args.from}–${args.to}: out of range`,
        content: `${doc.alias} has ${pages.length} pages. Ask for pages between 1 and ${pages.length}, at most 3 at a time.`,
      };
    }
    const text = doc.loaded.verifiable.text;
    const unreadable = new Set(doc.loaded.unreadablePages);
    const blocks: string[] = [];
    for (let n = args.from; n <= args.to; n++) {
      const page = pages[n - 1];
      if (unreadable.has(n)) {
        blocks.push(`--- Page ${n} ---\n[This page has no readable text. It may be a scanned image.]`);
        continue;
      }
      this.run.tracker.markRange(doc.id, page);
      blocks.push(`--- Page ${n} ---\n${text.slice(page.start, page.end).trim()}`);
    }
    const span = args.from === args.to ? `page ${args.from}` : `pages ${args.from}–${args.to}`;
    return { ok: true, label: `Reading ${span}`, content: this.truncate(`${doc.alias}, ${span}:\n${blocks.join("\n\n")}`) };
  }

  private async scan(doc: RunDoc, args: { question: string }): Promise<ToolOutcome> {
    if (this.scanned.has(doc.id)) {
      return {
        ok: false,
        label: `Scanning ${doc.name}: already done`,
        content: `${doc.alias} was already scanned for this question. Use those results; scan_document runs once per document.`,
      };
    }
    this.scanned.add(doc.id);

    const scan = await scanInto(this.run, [doc], args.question);
    const coverage = this.run.tracker.build("research").documents.find((d) => d.documentId === doc.id)!;
    const unit = coverage.unit === "page" ? "pages" : "sections";
    const caveat = coverage.failed.length
      ? ` ${unit[0].toUpperCase()}${unit.slice(1)} ${formatRanges(coverage.failed)} could not be read, so do not claim anything is absent from this document.`
      : "";
    const read = coverage.failed.length ? `${coverage.read.length} of ${coverage.total} ${unit}` : `all ${coverage.read.length} readable ${unit}`;

    if (!scan.excerpts.length) {
      return {
        ok: true,
        label: `Scanned ${read} of ${doc.name}: nothing relevant`,
        content: `Scanned ${read} of ${doc.alias}. No passage relevant to "${args.question}" was found.${caveat}`,
      };
    }
    const lines = scan.excerpts.map((e) => `[${e.label}] ${e.text}${e.note ? `\n  (note: ${e.note})` : ""}`);
    return {
      ok: true,
      label: `Scanned ${read} of ${doc.name}: ${scan.excerpts.length} relevant ${scan.excerpts.length === 1 ? "passage" : "passages"}`,
      content: this.truncate(`Scanned ${read} of ${doc.alias}. Relevant passages, in document order:\n${lines.join("\n")}${caveat}`),
    };
  }
}
