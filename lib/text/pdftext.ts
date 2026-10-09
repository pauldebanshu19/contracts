/**
 * How a PDF page's text is assembled from pdf.js text items. The server uses
 * this at ingestion and the viewer uses it on the same items from the same
 * pdf.js version, so a page-relative offset means the same thing on both sides
 * (PRD A1.3, B1.2).
 */

export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

/** Postgres can't store NUL in text. Swapping it for a space keeps every offset where it was. */
const NUL = /\u0000/g;

export function itemText(item: PdfTextItem): string {
  return item.str.includes("\u0000") ? item.str.replace(NUL, " ") : item.str;
}

export function pageTextFromItems(items: PdfTextItem[]): string {
  let text = "";
  for (const item of items) text += item.hasEOL ? `${itemText(item)}\n` : itemText(item);
  return text;
}

export const PAGE_SEPARATOR = "\n\n";
