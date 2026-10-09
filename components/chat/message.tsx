"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FileSearch,
  Loader2,
  OctagonX,
  RotateCcw,
  Search,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { formatCoverage } from "@/lib/chat/coverage";
import type { AgentStep, AnswerMode, AnswerStatus, ChatDocumentDTO, CitationDTO, Coverage, MessageStatus } from "@/lib/types";
import { Badge, Button, DocBadge, cn } from "../ui";
import { Markdown } from "./markdown";

/** An answer as it is being written or as it was saved. */
export interface AnswerView {
  content: string;
  citations: Record<number, CitationDTO>;
  pending: number[];
  steps: AgentStep[];
  status: MessageStatus;
  mode: AnswerMode | null;
  answerStatus: AnswerStatus | null;
  coverage: Coverage | null;
  error: string | null;
  /** Progress line such as "Reading pages 40–60…", only while streaming. */
  statusLine?: string | null;
}

interface QuoteProps {
  citation: CitationDTO | undefined;
  pending: boolean;
  documents: ChatDocumentDTO[];
  onOpen: (citation: CitationDTO) => void;
  /** Set as a block of its own, for a quote that stands alone in its paragraph. */
  block?: boolean;
}

const QUOTE_BLOCK = "my-3 block w-full rounded-r-lg border-l-[3px] px-4 py-3 text-left";


export function QuoteChip({ citation, pending, documents, onOpen, block }: QuoteProps) {
  if (!citation) {
    // Pending, or dropped when the answer was stopped: never the model's raw text.
    if (!pending) return null;
    return block ? (
      <span className={cn(QUOTE_BLOCK, "flex items-center gap-1.5 border-border-strong bg-surface-2 text-xs text-text-2")}>
        <Loader2 className="h-3 w-3 animate-spin" /> Checking quote…
      </span>
    ) : (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 align-baseline text-xs text-text-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking quote…
      </span>
    );
  }
  const doc = documents.find((d) => d.id === citation.documentId);
  const many = documents.length > 1;

  if (!citation.verified) {
    const reason = citation.reasonText?.replace(/^Unverified: /, "");
    if (block) {
      return (
        <span className={cn(QUOTE_BLOCK, "border-unverified/50 bg-unverified-soft/60")} title={citation.reasonText ?? "Unverified"}>
          <span className="block font-serif text-text-3 line-through decoration-text-3/60">“{citation.displayText}”</span>
          <span className="mt-2 flex items-start gap-1.5 text-xs text-unverified">
            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">Unverified</span>
              {reason ? ` · ${reason}` : null}
            </span>
          </span>
        </span>
      );
    }
    return (
      <span className="mx-0.5 rounded bg-unverified-soft/60 box-decoration-clone px-1 py-0.5" title={citation.reasonText ?? "Unverified"}>
        <span className="mr-1 inline-flex items-center gap-0.5 text-[11px] font-semibold not-italic text-unverified">
          <ShieldAlert className="h-3 w-3" /> Unverified
        </span>
        <span className="font-serif text-text-3 line-through decoration-text-3/60">“{citation.displayText}”</span>
        <span className="ml-1 text-[11px] text-unverified">{reason}</span>
      </span>
    );
  }

  const open = () => onOpen(citation);
  const title = `Open ${doc?.name ?? "the document"} at this passage`;
  const where = [citation.page ? `p. ${citation.page}` : null, citation.matches.length > 1 ? `${citation.matches.length} places` : null].filter(Boolean).join(" · ");

  if (block) {
    return (
      <button type="button" onClick={open} title={title} className={cn(QUOTE_BLOCK, "group/quote border-verified bg-verified-soft/70 transition-colors hover:bg-verified-soft")}>
        <span className="block font-serif text-text">“{citation.displayText}”</span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-verified">
          <span className="inline-flex items-center gap-1 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Verified
          </span>
          {where ? <span>{where}</span> : null}
          {many && citation.alias ? <DocBadge alias={citation.alias} /> : null}
          <span className="ml-auto inline-flex items-center gap-0.5 opacity-70 group-hover/quote:underline group-hover/quote:opacity-100">
            View in document <ArrowUpRight className="h-3 w-3" />
          </span>
        </span>
      </button>
    );
  }

  return (
    // A span, not a <button>: a button is laid out as one box, and a quote inside a sentence has to wrap with the line.
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      }}
      className="mx-0.5 cursor-pointer rounded bg-verified-soft box-decoration-clone px-1 py-0.5 transition-colors hover:bg-verified/20"
      title={title}
    >
      <CheckCircle2 className="mr-1 inline h-3 w-3 -translate-y-px text-verified" aria-label="Verified quote" />
      <span className="font-serif text-text">“{citation.displayText}”</span>
      <span className="ml-1 whitespace-nowrap text-[11px] font-medium text-verified">{where || "view"}</span>
      {many && citation.alias ? <DocBadge alias={citation.alias} className="ml-1 align-[1px]" /> : null}
    </span>
  );
}

function StepIcon({ step }: { step: AgentStep }) {
  if (step.status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-text-2" />;
  if (step.status === "error") return <AlertTriangle className="h-3.5 w-3.5 text-unverified" />;
  if (step.tool === "search_document") return <Search className="h-3.5 w-3.5 text-text-3" />;
  if (step.tool === "scan_document") return <FileSearch className="h-3.5 w-3.5 text-text-3" />;
  return <Wrench className="h-3.5 w-3.5 text-text-3" />;
}


function Steps({ steps, streaming }: { steps: AgentStep[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const expanded = streaming || open;
  return (
    <div className="mb-3 rounded-lg border border-border bg-bg text-xs">
      <button type="button" onClick={() => setOpen(!open)} disabled={streaming} className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-text-2 enabled:hover:text-text">
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">{streaming ? "Researching" : `${steps.length} research step${steps.length === 1 ? "" : "s"}`}</span>
      </button>
      {expanded ? (
        <ol className="space-y-1.5 px-3 pb-2.5">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2 text-text-2">
              <span className="mt-px">
                <StepIcon step={step} />
              </span>
              <span className={cn(step.status === "error" && "text-unverified")}>
                {step.label}
                {step.detail ? <span className="text-text-3"> · {step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function AssistantMessage({
  answer,
  documents,
  onOpenCitation,
  onRetry,
}: {
  answer: AnswerView;
  documents: ChatDocumentDTO[];
  onOpenCitation: (citation: CitationDTO) => void;
  onRetry?: () => void;
}) {
  const streaming = answer.status === "streaming";
  const citations = Object.values(answer.citations);
  const verified = citations.filter((c) => c.verified).length;
  const notFound = answer.answerStatus === "not_found";
  const empty = !answer.content.trim();
  const showUnsupported = !streaming && answer.status === "complete" && !notFound && verified === 0 && !empty;
  const stopped = answer.status === "stopped";
  const unverified = streaming ? 0 : citations.length - verified;
  const coverage = answer.coverage && !streaming ? formatCoverage(answer.coverage) : [];

  const renderCite = (ordinal: number, block?: boolean) => (
    <QuoteChip citation={answer.citations[ordinal]} pending={answer.pending.includes(ordinal)} documents={documents} onOpen={onOpenCitation} block={block} />
  );

  return (
    <div className="min-w-0">
      <Steps steps={answer.steps} streaming={streaming} />

      {showUnsupported ? (
        <div role="note" className="mb-3 flex items-start gap-2 rounded-lg border border-unverified/30 bg-unverified-soft px-3.5 py-2.5 text-sm text-unverified">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No supporting quote could be verified. Treat this answer as unsupported.</span>
        </div>
      ) : null}

      {notFound && !streaming ? (
        <div className="rounded-lg border border-border bg-bg px-4 py-3.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CircleSlash className="h-4 w-4 text-text-2" /> {documents.length > 1 ? "These documents don't address that" : "This contract doesn't address that"}
          </p>
          {answer.content.trim() ? <p className="mt-1 pl-6 text-sm leading-relaxed text-text-2">{answer.content.replace(/\[\[cite:\d+\]\]/g, "")}</p> : null}
        </div>
      ) : (
        <div className={cn("answer text-[15px] leading-7", streaming && "cursor")}>
          {empty && streaming ? (
            <span className="inline-flex items-center gap-2 text-sm text-text-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {answer.statusLine ?? "Reading the document…"}
            </span>
          ) : (
            <Markdown content={answer.content} renderCite={renderCite} />
          )}
        </div>
      )}

      {streaming && !empty && answer.statusLine ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-text-2">
          <Loader2 className="h-3 w-3 animate-spin" /> {answer.statusLine}
        </p>
      ) : null}

      {stopped || (!streaming && verified > 0) || unverified > 0 || coverage.length > 0 ? (
        // What the answer rests on: the quote counts, then how much of the document was read.
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-text-3">
          {stopped ? (
            <Badge>
              <OctagonX className="h-3 w-3" /> Stopped
            </Badge>
          ) : null}
          {!streaming && verified > 0 ? (
            <Badge tone="verified">
              <CheckCircle2 className="h-3 w-3" /> {verified} verified quote{verified === 1 ? "" : "s"}
            </Badge>
          ) : null}
          {unverified > 0 ? (
            <Badge tone="unverified">
              <ShieldAlert className="h-3 w-3" /> {unverified} unverified
            </Badge>
          ) : null}
          {coverage.length ? <span>{coverage[0]}</span> : null}
        </div>
      ) : null}

      {coverage.length > 1 ? (
        <ul className="mt-1.5 space-y-0.5 text-xs text-text-3">
          {coverage.slice(1).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {answer.status === "error" ? (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{answer.error ?? "The answer couldn't be completed."}</span>
          {onRetry ? (
            <Button size="sm" onClick={onRetry}>
              <RotateCcw className="h-3 w-3" /> Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
