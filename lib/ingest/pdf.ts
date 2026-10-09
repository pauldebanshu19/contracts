import path from "node:path";
import type { Segment } from "../text/normalize";
import { PAGE_SEPARATOR, pageTextFromItems, type PdfTextItem } from "../text/pdftext";
import { IngestError } from "./errors";




export const MIN_PAGE_CHARS = 20;

export interface PdfExtraction {
  text: string;
  pages: Segment[];
  /** Text items per page, kept so the viewer can check it sees the same page. */
  itemCounts: number[];
  /** 1-based page numbers with no readable text. */
  unreadablePages: number[];
}

const PDFJS_DIR = path.join(process.cwd(), "node_modules", "pdfjs-dist");
// pdf.js insists on a trailing forward slash, and Node reads the path either way.
const asUrl = (dir: string) => `${path.join(PDFJS_DIR, dir).split(path.sep).join("/")}/`;

const PDF_FORMAT_ERRORS = new Set(["InvalidPDFException", "FormatError", "XRefParseException", "UnknownErrorException", "ResponseException"]);

function classify(error: unknown): IngestError {
  if (error instanceof IngestError) return error;
  const name = (error as { name?: string })?.name ?? "";
  if (name === "PasswordException") {
    return new IngestError(
      "encrypted",
      "This PDF is password-protected, so its text can't be read. Remove the password and upload it again.",
    );
  }
  if (PDF_FORMAT_ERRORS.has(name)) {
    return new IngestError(
      "corrupt",
      "This PDF is damaged or incomplete and couldn't be opened. Try exporting it again from the original.",
    );
  }
  // Not the file's fault: keep the cause so it shows up in the server log.
  return new IngestError("internal", "Something went wrong while reading this PDF. Try again.", { cause: error });
}

export async function extractPdf(
  bytes: Uint8Array,
  onProgress?: (page: number, total: number) => void | Promise<void>,
): Promise<PdfExtraction> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // This pdf.js version has no document.destroy(); the loading task owns the cleanup.
  const task = pdfjs.getDocument({
      // pdf.js takes ownership of the buffer, so hand it a copy.
      data: new Uint8Array(bytes),
      cMapUrl: asUrl("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: asUrl("standard_fonts"),
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    throw classify(error);
  }

  try {
    const pages: Segment[] = [];
    const itemCounts: number[] = [];
    const unreadablePages: number[] = [];
    let text = "";

    for (let n = 1; n <= doc.numPages; n++) {
      let pageText = "";
      let count = 0;
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const items = content.items.filter((item): item is typeof item & PdfTextItem => "str" in item);
        pageText = pageTextFromItems(items);
        count = items.length;
        page.cleanup();
      } catch {
        // One unreadable page must not lose the rest; it is reported as not read.
      }

      if (n > 1) text += PAGE_SEPARATOR;
      pages.push({ start: text.length, end: text.length + pageText.length });
      text += pageText;
      itemCounts.push(count);
      if (pageText.replace(/\s/g, "").length < MIN_PAGE_CHARS) unreadablePages.push(n);
      await onProgress?.(n, doc.numPages);
    }

    return { text, pages, itemCounts, unreadablePages };
  } catch (error) {
    throw classify(error);
  } finally {
    await task.destroy().catch(() => {});
  }
}
