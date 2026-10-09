"use client";

import { locateOffset, type TextNodeSpan } from "@/lib/text/domtext";
import { normalizeWithMap, type Segment } from "@/lib/text/normalize";
import { PAGE_SEPARATOR } from "@/lib/text/pdftext";
import type { Box } from "./types";


export interface RenderedText {
  text: string;
  nodes: TextNodeSpan<Text>[];
}

/**
 * The text of a pdf.js text layer, rebuilt the way the server built it: each
 * text item's span in order, and a line break wherever pdf.js put a <br>.
 */
export function pdfLayerText(layer: HTMLElement): RenderedText {
  let text = "";
  const nodes: TextNodeSpan<Text>[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent?.getAttribute("role") !== "presentation") continue;
      const value = node.nodeValue ?? "";
      if (!value) continue;
      nodes.push({ node: node as Text, start: text.length, length: value.length });
      text += value;
    } else if ((node as Element).tagName === "BR") {
      text += "\n";
    }
  }
  return { text, nodes };
}

/** Boxes relative to `container`, merged so each line gets one box. */
export function rangeBoxes(range: Range, container: HTMLElement): Box[] {
  const origin = container.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  const boxes: Box[] = [];
  for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const box = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
    const last = boxes[boxes.length - 1];
    // Same line (overlapping vertically by most of a line): join into one box.
    if (last && Math.abs(last.top - box.top) < Math.min(last.height, box.height) * 0.6 && box.left <= last.left + last.width + 4) {
      const right = Math.max(last.left + last.width, box.left + box.width);
      const bottom = Math.max(last.top + last.height, box.top + box.height);
      last.left = Math.min(last.left, box.left);
      last.top = Math.min(last.top, box.top);
      last.width = right - last.left;
      last.height = bottom - last.top;
    } else {
      boxes.push(box);
    }
  }
  return boxes;
}

export function rangeFor(rendered: RenderedText, segment: Segment): Range | null {
  const start = locateOffset(rendered.nodes, segment.start, "start");
  const end = locateOffset(rendered.nodes, segment.end, "end");
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}


export function findInRendered(rendered: RenderedText, quote: string): Segment[] {
  const page = normalizeWithMap(rendered.text);
  const found: Segment[] = [];
  for (const part of quote.split(" … ")) {
    const key = normalizeWithMap(part).key;
    if (key.length < 8) continue;
    const at = page.key.indexOf(key);
    if (at === -1) continue;
    found.push({ start: page.map[at], end: page.map[at + key.length - 1] + 1 });
  }
  return found;
}

/** Split absolute offsets into page-relative pieces. */
export function splitByPage(segments: Segment[], pageStarts: number[], pageLengths: number[]): Map<number, Segment[]> {
  const out = new Map<number, Segment[]>();
  for (const segment of segments) {
    for (let i = 0; i < pageStarts.length; i++) {
      const start = pageStarts[i];
      const end = start + pageLengths[i];
      if (end <= segment.start) continue;
      if (start >= segment.end) break;
      const local = { start: Math.max(segment.start, start) - start, end: Math.min(segment.end, end) - start };
      if (local.end > local.start) out.set(i + 1, [...(out.get(i + 1) ?? []), local]);
    }
  }
  return out;
}

/** Page starts from page lengths, using the separator the server joined pages with. */
export function pageStartsFrom(lengths: number[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const length of lengths) {
    starts.push(at);
    at += length + PAGE_SEPARATOR.length;
  }
  return starts;
}
