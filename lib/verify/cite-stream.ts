export type AnswerStatus = "answered" | "partial" | "not_found";

export type CiteEvent =
  | { type: "text"; text: string }
  | { type: "cite_open"; index: number }
  | { type: "cite"; index: number; doc: string | null; quote: string }
  /** The stream ended inside a quote because the user pressed Stop. The quote is discarded. */
  | { type: "cite_abort"; index: number }
  | { type: "status"; status: AnswerStatus };

const MAX_OPEN_TAG = 200;
const MAX_STATUS = 80;
const MAX_QUOTE = 4000;
const TAGS = ["<cite", "</cite>", "<status>"];

function parseStatus(body: string): AnswerStatus | null {
  const word = body.toLowerCase().replace(/[^a-z]/g, "");
  if (word === "answered") return "answered";
  if (word === "partial") return "partial";
  if (word === "notfound") return "not_found";
  return null;
}

function parseDocAttr(tag: string): string | null {
  const m = /\bdoc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const value = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  return value ? value.toUpperCase() : null;
}

/** True when `tail` could still grow into one of the tags we act on. */
function couldBecomeTag(tail: string): boolean {
  const lower = tail.toLowerCase();
  return TAGS.some((tag) => (lower.length < tag.length ? tag.startsWith(lower) : lower.startsWith(tag)));
}

export class CiteStreamParser {
  private buf = "";
  private inCite = false;
  private quote = "";
  private doc: string | null = null;
  private count = 0;

  push(delta: string): CiteEvent[] {
    this.buf += delta;
    return this.drain(false);
  }

  end(options: { aborted?: boolean } = {}): CiteEvent[] {
    const events = this.drain(true);
    if (this.inCite) {
      // An unclosed quote at a natural end is still checked like any other.
      // After Stop it may be cut mid-word, so it is dropped.
      events.push(
        options.aborted
          ? { type: "cite_abort", index: this.count - 1 }
          : { type: "cite", index: this.count - 1, doc: this.doc, quote: this.quote },
      );
      this.inCite = false;
      this.quote = "";
    }
    return events;
  }

  private drain(final: boolean): CiteEvent[] {
    const events: CiteEvent[] = [];
    const text = (s: string) => {
      if (!s) return;
      const last = events[events.length - 1];
      if (last?.type === "text") last.text += s;
      else events.push({ type: "text", text: s });
    };
    const take = (s: string) => {
      if (this.inCite) this.quote += s;
      else text(s);
    };
    const closeCite = () => {
      events.push({ type: "cite", index: this.count - 1, doc: this.doc, quote: this.quote });
      this.inCite = false;
      this.quote = "";
    };

    for (;;) {
      const lt = this.buf.indexOf("<");
      if (lt === -1) {
        take(this.buf);
        this.buf = "";
        break;
      }
      take(this.buf.slice(0, lt));
      this.buf = this.buf.slice(lt);
      const lower = this.buf.toLowerCase();

      if (lower.startsWith("</cite>")) {
        if (this.inCite) closeCite(); // a stray close outside a quote is dropped
        this.buf = this.buf.slice(7);
        continue;
      }

      if (lower.startsWith("<cite") && (this.buf.length === 5 || /[\s>/]/.test(this.buf[5]))) {
        const gt = this.buf.indexOf(">");
        if (gt === -1 && this.buf.length <= MAX_OPEN_TAG && !final) break; // wait for the rest of the tag
        if (gt === -1) {
          // Never closed: drop the broken tag rather than show it.
          this.buf = "";
          break;
        }
        // A quote opened inside a quote ends the outer one.
        if (this.inCite) closeCite();
        this.doc = parseDocAttr(this.buf.slice(0, gt + 1));
        this.buf = this.buf.slice(gt + 1);
        this.inCite = true;
        this.quote = "";
        events.push({ type: "cite_open", index: this.count++ });
        continue;
      }

      if (lower.startsWith("<status>")) {
        const close = lower.indexOf("</status>");
        if (close === -1 && this.buf.length <= MAX_STATUS && !final) break;
        const body = close === -1 ? this.buf.slice(8) : this.buf.slice(8, close);
        const status = parseStatus(body);
        if (status) events.push({ type: "status", status });
        this.buf = close === -1 ? "" : this.buf.slice(close + 9);
        continue;
      }

      if (!final && couldBecomeTag(this.buf)) break; // partial tag at the end of the buffer

      // An ordinary "<".
      take("<");
      this.buf = this.buf.slice(1);
    }

    if (this.inCite && this.quote.length > MAX_QUOTE) {
      // A runaway quote: close it so it is checked (and fails) instead of swallowing the answer.
      closeCite();
    }
    return events;
  }
}

/**
 * Removes page references the model wrote itself (A3.5). The model is never
 * told page numbers, so any it reports are guesses; real locations come only
 * from the verifier. Works on a stream by holding back a possible partial
 * reference at the end of the buffer.
 */
const PAGE_WORD = "(?:pp?\\.|pg\\.?|pages?)";
const PAGE_NUMS = "\\d+(?:\\s*(?:[-\\u2013\\u2014,]|to|and)\\s*\\d+)*";
const PAGE_REFS = new RegExp(
  `\\s*[(\\[]\\s*(?:see\\s+|at\\s+|on\\s+)?${PAGE_WORD}\\s*${PAGE_NUMS}\\s*[)\\]]` +
    `|,?\\s+(?:on|at)\\s+${PAGE_WORD}\\s*${PAGE_NUMS}`,
  "gi",
);
const PARTIAL_PAGE_REF = /\s*[(\[][^)\]\n]{0,32}$|,?\s+(?:on|at)(?:\s+(?:p[a-z.]*(?:\s*[\d\s,\-–—]*)?)?)?$|,?\s+(?:o|a)?$/i;

export function stripPageRefs(text: string): string {
  return text.replace(PAGE_REFS, "");
}

export class PageRefScrubber {
  private held = "";

  push(text: string): string {
    this.held += text;
    const partial = PARTIAL_PAGE_REF.exec(this.held);
    const cut = partial ? partial.index : this.held.length;
    const ready = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return stripPageRefs(ready);
  }

  end(): string {
    const rest = stripPageRefs(this.held);
    this.held = "";
    return rest;
  }
}
