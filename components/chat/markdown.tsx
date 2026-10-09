"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Just enough Markdown for answers: paragraphs, lists, headings, tables, bold,
 * italic and code, with [[cite:n]] markers turned into quote chips. Model
 * output is never inserted as HTML.
 */

const INLINE = /(\[\[cite:\d+\]\])|(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;
/** A paragraph that is nothing but quotes: each is set as a block of its own instead of inside a sentence. */
const ONLY_CITES = /^(?:\[\[cite:\d+\]\]\s*)+$/;

/** `block` is true for a quote standing alone in its paragraph. */
type RenderCite = (ordinal: number, block?: boolean) => ReactNode;

function inline(text: string, renderCite: RenderCite, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const k = `${key}-${n++}`;
    if (match[1]) out.push(<Fragment key={k}>{renderCite(Number(token.slice(7, -2)))}</Fragment>);
    else if (match[2]) out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else if (match[3]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else out.push(<em key={k}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function Markdown({ content, renderCite }: { content: string; renderCite: RenderCite }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;

    if (!line.trim()) {
      i++;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, renderCite, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>{row.map((c, j) => <td key={j}>{inline(c, renderCite, `${key}r${r}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = heading[1].length <= 2 ? "h3" : "h4";
      blocks.push(<Tag key={key}>{inline(heading[2], renderCite, key)}</Tag>);
      i++;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && Boolean(m[2]) === ordered) {
          items.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`; // continuation of the item above
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key}>
          {items.map((text, j) => (
            <li key={j}>{inline(text, renderCite, `${key}i${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !(TABLE_ROW.test(lines[i]) && TABLE_RULE.test(lines[i + 1] ?? ""))) {
      para.push(lines[i].trim());
      i++;
    }
    const text = para.join(" ");
    if (ONLY_CITES.test(text)) {
      for (const [n, cite] of [...text.matchAll(/\[\[cite:(\d+)\]\]/g)].entries()) {
        blocks.push(<Fragment key={`${key}-${n}`}>{renderCite(Number(cite[1]), true)}</Fragment>);
      }
      continue;
    }
    blocks.push(<p key={key}>{inline(text, renderCite, key)}</p>);
  }
  return <>{blocks}</>;
}
