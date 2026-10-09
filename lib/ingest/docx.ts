import { collectDomText } from "../text/domtext";
import type { LineHint } from "../text/segment";
import { IngestError } from "./errors";

/**
 * DOCX extraction: mammoth to HTML, the HTML rebuilt from an allowlist, and
 * the text read from that HTML's text nodes. The viewer renders the same HTML,
 * so viewer and verifier read identical text (PRD "DOCX" row).
 */

export interface DocxExtraction {
  html: string;
  text: string;
  hints: LineHint[];
}

// Everything else is dropped; its text is kept.
const KEEP = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "strong", "b", "em", "i", "u", "s", "sup", "sub", "br", "blockquote",
]);
// Dropped together with their contents.
const DROP = new Set(["script", "style", "img", "svg", "iframe", "object", "embed", "head", "title", "meta", "link"]);
const SPAN_ATTRS = new Set(["colspan", "rowspan"]);

interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Rebuild the HTML from scratch, so nothing that isn't on the allowlist can survive. */
function rebuild(node: DomNode): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";

  const name = node.nodeName.toLowerCase();
  if (DROP.has(name)) return "";
  let inner = "";
  for (let i = 0; i < node.childNodes.length; i++) inner += rebuild(node.childNodes[i]);
  if (!KEEP.has(name)) return inner;
  if (name === "br") return "<br>";

  let attrs = "";
  if (name === "td" || name === "th") {
    for (const attr of SPAN_ATTRS) {
      const value = node.getAttribute?.(attr);
      if (value && /^\d{1,3}$/.test(value)) attrs += ` ${attr}="${value}"`;
    }
  }
  return `<${name}${attrs}>${inner}</${name}>`;
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxExtraction> {
  const mammoth = await import("mammoth");
  const { parseHTML } = await import("linkedom");

  let raw: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      // Images carry no text and would bloat the stored HTML.
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
    );
    raw = result.value;
  } catch {
    throw new IngestError(
      "corrupt",
      "This Word file is damaged or incomplete and couldn't be opened. Try saving it again as .docx.",
    );
  }

  const source = parseHTML(`<!doctype html><html><body>${raw}</body></html>`).document;
  const html = rebuild(source.body as unknown as DomNode).replace(/^<body>|<\/body>$/g, "");

  // Read the text back from the HTML that will actually be stored and rendered.
  const stored = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
  const hints: LineHint[] = [];
  const listDepth = (element: DomNode & { parentNode?: unknown }): number => {
    let depth = 0;
    for (let p = element.parentNode as (DomNode & { parentNode?: unknown }) | null; p; p = p.parentNode as typeof p) {
      if (p.nodeName === "OL" || p.nodeName === "UL") depth++;
    }
    return depth;
  };
  const { text } = collectDomText(stored.body as unknown as DomNode & { parentNode?: unknown }, (element, offset) => {
    const heading = /^H([1-6])$/.exec(element.nodeName);
    if (heading) hints.push({ offset, headingLevel: Number(heading[1]) });
    // Word auto-numbering isn't in the text, but a numbered paragraph still starts a clause.
    else if (element.nodeName === "LI" && (element as DomNode & { parentNode?: DomNode }).parentNode?.nodeName === "OL") {
      hints.push({ offset, headingLevel: Math.min(6, listDepth(element)) });
    }
  });

  return { html, text, hints: dedupe(hints) };
}

/** Nested blocks can start at the same offset; the outermost one wins. */
function dedupe(hints: LineHint[]): LineHint[] {
  const seen = new Set<number>();
  return hints.filter((hint) => (seen.has(hint.offset) ? false : (seen.add(hint.offset), true)));
}
