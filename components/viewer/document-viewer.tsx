"use client";

import DOMPurify from "dompurify";
import { AlertTriangle, ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { collectDomText } from "@/lib/text/domtext";
import type { Segment } from "@/lib/text/normalize";
import { IconButton, Spinner } from "../ui";
import { findInRendered, pageStartsFrom, pdfLayerText, rangeBoxes, rangeFor, splitByPage, type RenderedText } from "./highlight";
import type { Box, ViewMeta, ViewerTarget } from "./types";

// Set here, in the module that renders <Document>, as react-pdf requires. Same pdf.js version as the server.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

const PDF_OPTIONS = { cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/" };
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2];
/** Pages either side of the visible ones that are rendered ahead (PRD B1.8). */
const RENDER_AHEAD = 2;

interface Props {
  target: ViewerTarget;
  document: { id: string; name: string };
  onClose: () => void;
}

/** The document viewer (PRD B1): opens at the passage, highlights it, and steps between occurrences. */
export function DocumentViewer({ target, document: doc, onClose }: Props) {
  const [meta, setMeta] = useState<ViewMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [occurrence, setOccurrence] = useState(target.primary);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${doc.id}/view`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Couldn't open the document.");
        if (!cancelled) setMeta(body as ViewMeta);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't open the document."));
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  const segments = target.matches[occurrence]?.segments ?? [];
  const count = target.matches.length;
  const zoomIndex = ZOOMS.indexOf(zoom);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface pl-4 pr-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={doc.name}>
            {doc.name}
          </p>
          <p className="text-[11px] text-text-3">
            {meta?.kind === "pdf" && meta.pageCount ? `Page ${currentPage ?? "–"} of ${meta.pageCount}` : meta?.kind === "docx" ? "Word document" : " "}
          </p>
        </div>
        {count > 1 ? (
          <div className="flex items-center gap-1 rounded-md border border-border px-1 text-xs text-text-2">
            <IconButton label="Previous occurrence" onClick={() => setOccurrence((o) => (o - 1 + count) % count)}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </IconButton>
            <span className="tabular-nums" title="The same words appear in several places">
              Occurrence {occurrence + 1} of {count}
            </span>
            <IconButton label="Next occurrence" onClick={() => setOccurrence((o) => (o + 1) % count)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ) : null}
        <div className="flex items-center gap-0.5 rounded-md border border-border px-1 text-xs text-text-2">
          <IconButton label="Zoom out" disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOMS[Math.max(0, zoomIndex - 1)])}>
            <Minus className="h-3.5 w-3.5" />
          </IconButton>
          <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <IconButton label="Zoom in" disabled={zoomIndex >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)])}>
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <IconButton label="Close viewer" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </header>

      {notice ? (
        <p className="flex items-center gap-2 border-b border-border bg-unverified-soft px-3 py-1.5 text-xs text-unverified">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {notice}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {error ? (
          <p className="m-4 flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        ) : !meta ? (
          <div className="flex h-full items-center justify-center text-sm text-text-2">
            <Spinner /> <span className="ml-2">Opening {doc.name}…</span>
          </div>
        ) : meta.kind === "pdf" ? (
          <PdfView
            meta={meta}
            segments={segments}
            scrollKey={`${target.key}-${occurrence}`}
            displayText={target.displayText}
            zoom={zoom}
            onPage={setCurrentPage}
            onNotice={setNotice}
          />
        ) : (
          <DocxView meta={meta} segments={segments} scrollKey={`${target.key}-${occurrence}`} displayText={target.displayText} zoom={zoom} onNotice={setNotice} />
        )}
      </div>
    </div>
  );
}

function HighlightLayer({ boxes }: { boxes: Box[] }) {
  return (
    <>
      {boxes.map((b, i) => (
        <div key={i} className="hl-box" style={{ left: b.left - 1, top: b.top - 1, width: b.width + 2, height: b.height + 2 }} />
      ))}
    </>
  );
}

const PAGE_GAP = 16;

/** Scroll so that a point inside `element` sits a third of the way down the scroller. */
function scrollToPoint(scroller: HTMLElement, element: HTMLElement, offsetTop: number) {
  const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + offsetTop;
  scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: "smooth" });
}

function PdfView({
  meta,
  segments,
  scrollKey,
  displayText,
  zoom,
  onPage,
  onNotice,
}: {
  meta: ViewMeta;
  segments: Segment[];
  scrollKey: string;
  displayText?: string;
  zoom: number;
  onPage: (page: number) => void;
  onNotice: (notice: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState(1.294); // US Letter until the first page is measured
  const [numPages, setNumPages] = useState(meta.pageCount ?? 0);
  // Page placeholders exist only after the document has loaded; effects that look them up wait for this.
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState<Set<number>>(new Set([1]));
  // Boxes remember the page width and occurrence they were measured for: after a zoom, resize or
  // occurrence change they are stale until that page's text layer reports it has finished redrawing.
  const [boxes, setBoxes] = useState<Map<number, { width: number; key: string; boxes: Box[] }>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const scrolledFor = useRef<string | null>(null);

  const starts = useMemo(() => pageStartsFrom(meta.pageLengths), [meta.pageLengths]);
  const byPage = useMemo(() => splitByPage(segments, starts, meta.pageLengths), [segments, starts, meta.pageLengths]);
  const targetPages = useMemo(() => [...byPage.keys()].sort((a, b) => a - b), [byPage]);
  const firstTarget = targetPages[0] ?? null;

  // Fit the page to the pane, then apply zoom; redraw on resize (PRD B1.3).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth - 48));
    // Measured now as well: ResizeObserver only reports on a rendered frame, which a background tab may not get.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const pageWidth = Math.round(width * zoom);
  const pageHeight = Math.round(pageWidth * aspect);
  // The page width is part of the key, so after a zoom or resize the view returns to the passage.
  const anchorKey = `${scrollKey}@${pageWidth}`;

  // Track which pages are on screen; only those (± a few) are rendered.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !loaded) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(Number((entry.target as HTMLElement).dataset.page), entry.intersectionRatio);
        const onScreen = [...ratios.entries()].filter(([, r]) => r > 0).map(([p]) => p);
        if (onScreen.length) {
          setVisible(new Set(onScreen));
          const best = [...ratios.entries()].sort((a, b) => b[1] - a[1])[0];
          if (best) onPage(best[0]);
        }
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [loaded, pageHeight, onPage]);

  // Bring the target page into view at once, so it renders before the highlight is drawn (B1.1, B1.8).
  // Waits for the page placeholders, which exist only once the document has loaded.
  useEffect(() => {
    if (!firstTarget || !pageHeight || !loaded) return;
    const el = pageRefs.current.get(firstTarget);
    if (el && scrolledFor.current !== anchorKey) el.scrollIntoView({ block: "start" });
  }, [firstTarget, anchorKey, pageHeight, loaded]);

  const rendered = useMemo(() => {
    const pages = new Set<number>(targetPages);
    for (const p of visible) for (let d = -RENDER_AHEAD; d <= RENDER_AHEAD; d++) if (p + d >= 1 && p + d <= numPages) pages.add(p + d);
    return pages;
  }, [visible, targetPages, numPages]);

  const drawPage = useCallback(
    (pageNumber: number) => {
      const wrapper = pageRefs.current.get(pageNumber);
      const layer = wrapper?.querySelector<HTMLElement>(".textLayer");
      const local = byPage.get(pageNumber);
      if (!wrapper || !layer || !local?.length) {
        setBoxes((m) => (m.has(pageNumber) ? new Map([...m].filter(([p]) => p !== pageNumber)) : m));
        return;
      }

      const text: RenderedText = pdfLayerText(layer);
      const expected = meta.pageLengths[pageNumber - 1];
      const aligned = text.text.length === expected;
      if (process.env.NODE_ENV !== "production") {
        // Dev check (B1.2): the text layer must rebuild exactly the text the server extracted.
        console.debug(`[viewer] page ${pageNumber}: ${aligned ? "text layer matches extraction" : `MISMATCH ${text.text.length} vs ${expected} chars`}`);
      }

      const found: Box[] = [];
      if (aligned) {
        for (const segment of local) {
          const range = rangeFor(text, segment);
          if (range) found.push(...rangeBoxes(range, wrapper));
        }
      }
      if (!found.length && displayText) {
        // The layer differs from extraction on this page: find the quote's words on screen instead.
        for (const segment of findInRendered(text, displayText)) {
          const range = rangeFor(text, segment);
          if (range) found.push(...rangeBoxes(range, wrapper));
        }
      }
      if (found.length) onNotice(null);
      else if (!aligned) onNotice("This page's text layer differs from the extracted text, so the passage couldn't be highlighted exactly. It is on this page.");
      setBoxes((m) => new Map(m).set(pageNumber, { width: pageWidth, key: scrollKey, boxes: found }));

      // Scroll to the first highlighted line once per occurrence, and again after a zoom or resize.
      if (pageNumber === firstTarget && found.length && scrolledFor.current !== anchorKey && scroller.current) {
        scrolledFor.current = anchorKey;
        scrollToPoint(scroller.current, wrapper, found[0].top);
      }
    },
    [anchorKey, byPage, displayText, firstTarget, meta.pageLengths, onNotice, pageWidth, scrollKey],
  );

  // react-pdf re-renders a text layer whenever its callback changes, so each page gets one stable callback.
  const drawRef = useRef(drawPage);
  useLayoutEffect(() => {
    drawRef.current = drawPage;
  });
  const onTextLayer = useCallback((pageNumber: number) => drawRef.current(pageNumber), []);

  // Another occurrence at the same width: the rendered text layers are complete, so redraw them now.
  // (After a width change, each page redraws itself when its new text layer is ready.)
  useEffect(() => {
    onNotice(null);
    for (const page of pageRefs.current.keys()) drawRef.current(page);
  }, [scrollKey, onNotice]);

  const currentBoxes = (page: number): Box[] => {
    const entry = boxes.get(page);
    return entry && entry.width === pageWidth && entry.key === scrollKey ? entry.boxes : [];
  };

  if (loadError) {
    return <p className="m-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{loadError}</p>;
  }

  return (
    // A stable scrollbar gutter: the scrollbar appearing must not change the page width and shift every page.
    <div ref={scroller} className="h-full overflow-auto px-6 py-4 [scrollbar-gutter:stable]">
      {width > 0 ? (
        <Document
          file={`/api/documents/${meta.id}/file`}
          options={PDF_OPTIONS}
          suspense={false}
          loading={
            <div className="flex items-center justify-center py-10 text-sm text-text-2">
              <Spinner /> <span className="ml-2">Loading PDF…</span>
            </div>
          }
          onLoadSuccess={async (pdf) => {
            setNumPages(pdf.numPages);
            setLoaded(true);
            const first = await pdf.getPage(1);
            const viewport = first.getViewport({ scale: 1 });
            setAspect(viewport.height / viewport.width);
          }}
          onLoadError={(e) => setLoadError(`Couldn't load the PDF: ${e.message}`)}
        >
          {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
            <div
              key={n}
              data-page={n}
              ref={(el) => {
                if (el) pageRefs.current.set(n, el);
                else pageRefs.current.delete(n);
              }}
              className="pdf-page relative mx-auto bg-white shadow-sm ring-1 ring-black/5"
              style={{ width: pageWidth, minHeight: pageHeight, marginBottom: PAGE_GAP }}
            >
              {rendered.has(n) ? (
                <PdfPage pageNumber={n} width={pageWidth} height={pageHeight} onTextLayer={onTextLayer} />
              ) : (
                <div className="flex items-center justify-center text-xs text-text-3" style={{ height: pageHeight }}>
                  Page {n}
                </div>
              )}
              {meta.unreadablePages.includes(n) ? (
                <p className="absolute inset-x-0 top-2 mx-auto w-fit rounded bg-unverified-soft px-2 py-1 text-[11px] text-unverified">No readable text on this page: it was not read.</p>
              ) : null}
              <HighlightLayer boxes={currentBoxes(n)} />
            </div>
          ))}
        </Document>
      ) : null}
    </div>
  );
}

/** One rendered page. Its text-layer callback keeps the same identity across renders (see onTextLayer). */
function PdfPage({ pageNumber, width, height, onTextLayer }: { pageNumber: number; width: number; height: number; onTextLayer: (page: number) => void }) {
  const onSuccess = useCallback(() => onTextLayer(pageNumber), [onTextLayer, pageNumber]);
  return (
    <Page
      pageNumber={pageNumber}
      width={width}
      renderAnnotationLayer={false}
      loading={<div style={{ height }} />}
      onRenderTextLayerSuccess={onSuccess}
    />
  );
}

const DOCX_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "strong", "b", "em", "i", "u", "s", "sup", "sub", "br", "blockquote"];

function DocxView({
  meta,
  segments,
  scrollKey,
  displayText,
  zoom,
  onNotice,
}: {
  meta: ViewMeta;
  segments: Segment[];
  scrollKey: string;
  displayText?: string;
  zoom: number;
  onNotice: (notice: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const scrolledFor = useRef<string | null>(null);
  // Sanitised on the server at ingestion and again here before it touches the DOM (PRD "Safety").
  const html = useMemo(() => DOMPurify.sanitize(meta.html ?? "", { ALLOWED_TAGS: DOCX_TAGS, ALLOWED_ATTR: ["colspan", "rowspan"] }), [meta.html]);

  const draw = useCallback(() => {
    const el = body.current;
    const box = frame.current;
    if (!el || !box) return;
    const rendered = collectDomText(el as unknown as Parameters<typeof collectDomText>[0]) as unknown as RenderedText;
    const aligned = rendered.text.length === meta.textLength;
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[viewer] docx: ${aligned ? "rendered text matches extraction" : `MISMATCH ${rendered.text.length} vs ${meta.textLength} chars`}`);
    }
    let found: Box[] = [];
    const ranges = aligned ? segments : displayText ? findInRendered(rendered, displayText) : [];
    for (const segment of ranges) {
      const range = rangeFor(rendered, segment);
      if (range) found = found.concat(rangeBoxes(range, box));
    }
    onNotice(!found.length && segments.length ? "The passage couldn't be located in the rendered document." : null);
    setBoxes(found);
    if (found.length && scrolledFor.current !== scrollKey && scroller.current) {
      scrolledFor.current = scrollKey;
      scrollToPoint(scroller.current, box, found[0].top);
    }
  }, [displayText, meta.textLength, onNotice, scrollKey, segments]);

  useLayoutEffect(() => {
    draw();
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(el);
    return () => observer.disconnect();
  }, [draw, zoom, html]);

  return (
    <div ref={scroller} className="h-full overflow-auto px-6 py-6">
      <div className="relative mx-auto max-w-[52rem] rounded bg-white px-10 py-8 shadow-sm ring-1 ring-black/5">
        <div ref={frame} className="relative">
          <div ref={body} className="docx-body" style={{ fontSize: `${16 * zoom}px` }} dangerouslySetInnerHTML={{ __html: html }} />
          <HighlightLayer boxes={boxes} />
        </div>
      </div>
    </div>
  );
}
