"use client";

import { diffWords } from "diff";
import { AlertTriangle, ArrowLeftRight, ArrowRight, ChevronDown, ChevronRight, ExternalLink, Info, RotateCcw } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import type { ViewerTarget } from "../viewer/types";
import { Badge, Button, Spinner, cn } from "../ui";

const DocumentViewer = dynamic(() => import("../viewer/document-viewer").then((m) => m.DocumentViewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-text-2">
      <Spinner /> <span className="ml-2">Opening viewer…</span>
    </div>
  ),
});

type Significance = "high" | "medium" | "low" | "cosmetic";
type ChangeType = "modified" | "added" | "removed" | "moved" | "cosmetic";

interface ClauseSide {
  number: string | null;
  heading: string | null;
  start: number;
  end: number;
  text: string | null;
}

interface Change {
  id: string;
  ordinal: number;
  type: ChangeType;
  significance: Significance;
  floor: Significance;
  floorReasons: string[];
  category: string;
  summary: string;
  a: ClauseSide | null;
  b: ClauseSide | null;
}

interface Comparison {
  id: string;
  status: "processing" | "ready" | "failed";
  stage: string | null;
  summary: string[];
  notice: string | null;
  error: string | null;
  a: { id: string; name: string; kind: string };
  b: { id: string; name: string; kind: string };
  changes: Change[];
}

const SIGNIFICANCE: Significance[] = ["high", "medium", "low", "cosmetic"];
const TYPES: ChangeType[] = ["modified", "added", "removed", "moved", "cosmetic"];
const RANK: Record<Significance, number> = { high: 3, medium: 2, low: 1, cosmetic: 0 };
const SIG_LABEL: Record<Significance, string> = { high: "High", medium: "Medium", low: "Low", cosmetic: "Cosmetic" };
const TYPE_LABEL: Record<ChangeType, string> = { modified: "Modified", added: "Added", removed: "Removed", moved: "Moved", cosmetic: "Cosmetic" };

function SignificanceBadge({ value }: { value: Significance }) {
  const tone = value === "high" ? "danger" : value === "medium" ? "unverified" : value === "low" ? "accent" : "neutral";
  return <Badge tone={tone}>{SIG_LABEL[value]}</Badge>;
}

function clauseLabel(side: ClauseSide | null): string {
  if (!side) return "";
  const number = side.number ? (/^\d/.test(side.number) ? `§${side.number}` : side.number) : "";
  return [number, side.heading].filter(Boolean).join(" ") || "Untitled clause";
}

function reflow(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .join("\n\n");
}

function DiffText({ before, after, side }: { before: string; after: string; side: "a" | "b" }) {
  const parts = useMemo(() => diffWords(reflow(before), reflow(after)), [before, after]);
  return (
    <p className="whitespace-pre-wrap font-serif text-[14px] leading-relaxed">
      {parts.map((part, i) => {
        // The other side's change is hidden, but any space it carried still separates the words around it.
        const gap = /\s/.test(part.value) ? " " : null;
        if (part.added) return side === "b" ? <ins key={i} className="diff-ins no-underline">{part.value}</ins> : gap;
        if (part.removed) return side === "a" ? <del key={i} className="diff-del">{part.value}</del> : gap;
        return <span key={i}>{part.value}</span>;
      })}
    </p>
  );
}

export function CompareView({ id, onOpenComparison }: { id: string; onOpenComparison: (id: string) => void }) {
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sigFilter, setSigFilter] = useState<Set<Significance>>(new Set(["high", "medium", "low"]));
  const [typeFilter, setTypeFilter] = useState<Set<ChangeType>>(new Set(TYPES));
  const [sort, setSort] = useState<"significance" | "order">("significance");
  const [open, setOpen] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ target: ViewerTarget; doc: { id: string; name: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/comparisons/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Couldn't load the comparison.");
      setData(body.comparison);
      setError(null);
      return body.comparison as Comparison;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the comparison.");
      return null;
    }
  }, [id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = async () => {
      const next = await load();
      if (!cancelled && next?.status === "processing") timer = setTimeout(tick, 1200);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const counts = useMemo(() => {
    const bySig = new Map<Significance, number>();
    const byType = new Map<ChangeType, number>();
    for (const c of data?.changes ?? []) {
      // Each count reflects the other filter, so the numbers say what clicking would show.
      if (typeFilter.has(c.type)) bySig.set(c.significance, (bySig.get(c.significance) ?? 0) + 1);
      if (sigFilter.has(c.significance)) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
    }
    return { bySig, byType };
  }, [data, sigFilter, typeFilter]);

  const shown = useMemo(() => {
    const list = (data?.changes ?? []).filter((c) => sigFilter.has(c.significance) && typeFilter.has(c.type));
    return sort === "order" ? list : [...list].sort((x, y) => RANK[y.significance] - RANK[x.significance] || x.ordinal - y.ordinal);
  }, [data, sigFilter, typeFilter, sort]);

  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const swap = async () => {
    if (!data) return;
    setBusy(true);
    try {
      onOpenComparison(await api.compare(data.b.id, data.a.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't swap the versions.");
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await api.compare(data.a.id, data.b.id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openSide = (doc: { id: string; name: string }, side: ClauseSide) =>
    setViewer({
      doc,
      target: { documentId: doc.id, matches: [{ segments: [{ start: side.start, end: side.end }] }], primary: 0, key: `${doc.id}-${side.start}-${++opened.current}` },
    });

  if (error && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="flex items-center gap-2 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-2">
        <Spinner /> <span className="ml-2">Loading comparison…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex min-w-0 flex-col", viewer ? "w-[52%] border-r border-border" : "flex-1")}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 text-[15px] tracking-tight">
            <span className="truncate font-semibold" title={data.a.name}>
              {data.a.name}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-text-3" />
            <span className="truncate font-semibold" title={data.b.name}>
              {data.b.name}
            </span>
          </div>
          <Button size="sm" onClick={swap} disabled={busy} title="Treat the other document as the earlier version">
            <ArrowLeftRight className="h-3.5 w-3.5" /> Swap versions
          </Button>
        </header>

        {/* Tinted, so the cards stand off it. The side padding grows on a wide pane to hold the cards to a readable width. */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg px-[max(1.5rem,calc((100%_-_65rem)/2))] py-6">
          {data.status === "processing" ? (
            <div className="mx-auto mt-16 max-w-sm text-center text-sm text-text-2">
              <Spinner className="mx-auto mb-3 h-5 w-5" />
              <p className="font-medium text-text">Comparing versions…</p>
              <p className="mt-1">{data.stage ?? "Queued"}</p>
            </div>
          ) : data.status === "failed" ? (
            <div className="mx-auto mt-16 max-w-sm rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" /> The comparison failed
              </p>
              <p className="mt-1">{data.error}</p>
              <Button size="sm" className="mt-3" onClick={retry} disabled={busy}>
                <RotateCcw className="h-3 w-3" /> Try again
              </Button>
            </div>
          ) : (
            <>
              <section className="rounded-lg border border-border bg-surface p-4">
                <h2 className="text-sm font-semibold">What changed</h2>
                {data.summary.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text">
                    {data.summary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-text-2">No differences in substance were found. {data.changes.length ? "Only formatting changed." : "The two versions have the same clauses."}</p>
                )}
                {data.notice ? (
                  <p className="mt-3 flex items-start gap-2 rounded bg-unverified-soft px-2.5 py-1.5 text-xs text-unverified">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" /> {data.notice}
                  </p>
                ) : null}
              </section>

              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-text-3">Significance</span>
                  {SIGNIFICANCE.map((s) => (
                    <FilterChip key={s} active={sigFilter.has(s)} onClick={() => toggle(sigFilter, s, setSigFilter)}>
                      {SIG_LABEL[s]} <span className="tabular-nums opacity-70">{counts.bySig.get(s) ?? 0}</span>
                    </FilterChip>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-text-3">Type</span>
                  {TYPES.map((t) => (
                    <FilterChip key={t} active={typeFilter.has(t)} onClick={() => toggle(typeFilter, t, setTypeFilter)}>
                      {TYPE_LABEL[t]} <span className="tabular-nums opacity-70">{counts.byType.get(t) ?? 0}</span>
                    </FilterChip>
                  ))}
                </div>
                <label className="ml-auto flex items-center gap-1.5 text-text-3">
                  Sort
                  <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded border border-border bg-surface px-1.5 py-1 text-xs text-text">
                    <option value="significance">By significance</option>
                    <option value="order">Document order</option>
                  </select>
                </label>
              </div>

              <ul className="mt-3 space-y-2">
                {shown.length === 0 ? (
                  <li className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-2">No changes match these filters.</li>
                ) : null}
                {shown.map((change) => {
                  const expanded = open === change.id;
                  const side = change.b ?? change.a;
                  return (
                    <li key={change.id} className="rounded-lg border border-border bg-surface">
                      <button type="button" onClick={() => setOpen(expanded ? null : change.id)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
                        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-text-3" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <SignificanceBadge value={change.significance} />
                            <Badge>{TYPE_LABEL[change.type]}</Badge>
                            <span className="text-xs text-text-3">{change.category.replace(/_/g, " ")}</span>
                            <span className="text-xs font-medium text-text-2">{clauseLabel(side)}</span>
                          </div>
                          <p className="mt-1 text-sm">{change.summary}</p>
                        </div>
                      </button>
                      {expanded ? (
                        <div className="border-t border-border px-4 py-3">
                          {change.floorReasons.length ? (
                            <p className="mb-3 text-xs text-text-3">
                              Rule check: {change.floorReasons.join("; ")}
                              {RANK[change.significance] > RANK[change.floor] ? ` (raised from ${SIG_LABEL[change.floor]} by the model)` : ""}
                            </p>
                          ) : null}
                          <div className="grid grid-cols-2 gap-3">
                            {(["a", "b"] as const).map((key) => {
                              const clause = change[key];
                              const doc = data[key];
                              return (
                                <div key={key} className="min-w-0 rounded-md bg-surface-2/60 p-3">
                                  <div className="mb-2 flex items-center gap-2 text-xs text-text-2">
                                    <span className="font-medium">{key === "a" ? "Before" : "After"}</span>
                                    <span className="truncate text-text-3">{clause ? clauseLabel(clause) : ""}</span>
                                    {clause ? (
                                      <button type="button" className="ml-auto inline-flex shrink-0 items-center gap-1 text-accent-text hover:underline" onClick={() => openSide(doc, clause)}>
                                        Open <ExternalLink className="h-3 w-3" />
                                      </button>
                                    ) : null}
                                  </div>
                                  {clause?.text ? (
                                    <DiffText before={change.a?.text ?? ""} after={change.b?.text ?? ""} side={key} />
                                  ) : (
                                    <p className="text-sm italic text-text-3">{key === "a" ? "Not in the earlier version." : "Deleted in the later version."}</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </section>
      {viewer ? (
        <section className="min-w-0 flex-1 bg-surface-2">
          <DocumentViewer key={viewer.target.key} target={viewer.target} document={viewer.doc} onClose={() => setViewer(null)} />
        </section>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 transition-colors",
        active ? "border-accent bg-accent-soft text-accent-text" : "border-border bg-surface text-text-3 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
