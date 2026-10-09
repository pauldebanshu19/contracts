/** Types shared by the server and the browser. No server-only imports here. */

export type AnswerMode = "targeted" | "full_scan" | "research";
export type AnswerStatus = "answered" | "partial" | "not_found";
export type MessageStatus = "streaming" | "complete" | "stopped" | "error";
export type DocKind = "pdf" | "docx";

/** One contiguous piece of a matched quote, in canonical text offsets. */
export interface StoredSegment {
  start: number;
  end: number;
  /** 1-based page for PDFs, null for DOCX. */
  page: number | null;
  /** Where that page's text starts, so `start - pageStart` is an offset into the page. */
  pageStart: number;
}

export interface StoredMatch {
  start: number;
  end: number;
  segments: StoredSegment[];
}

export interface DocCoverage {
  documentId: string;
  alias: string;
  name: string;
  /** PDFs are counted in pages; DOCX files have no fixed pages, so they are counted in sections. */
  unit: "page" | "section";
  total: number;
  /** Sorted 1-based page (or section) numbers sent to the model. */
  read: number[];
  /** Pages with no readable text. They are never counted as read. */
  unreadable: number[];
  /** Pages (or sections) a failed step should have read but didn't. */
  failed: number[];
}

export interface Coverage {
  mode: AnswerMode;
  documents: DocCoverage[];
  /** True only when every readable page of every document was read and nothing failed. */
  complete: boolean;
  /** A targeted answer came back "not found" and was replaced by a full read. */
  escalated?: boolean;
  /** Research stopped at its round or token limit. */
  stoppedAtLimit?: boolean;
  /** Anything else about how the answer was produced that limits it, e.g. research wasn't available or a time limit was reached. */
  note?: string;
}

export interface AgentStep {
  id: number;
  tool: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
}

export interface CitationDTO {
  ordinal: number;
  documentId: string | null;
  alias: string | null;
  verified: boolean;
  reason: string | null;
  reasonText: string | null;
  /** Document text when verified. For unverified quotes this is the model's text, shown struck through. */
  displayText: string;
  matches: StoredMatch[];
  primary: number;
  /** Page of the primary match, for the chip label. */
  page: number | null;
}

export type StreamEvent =
  | { type: "start"; userMessageId: string; assistantMessageId: string }
  | { type: "text"; text: string }
  | { type: "cite_pending"; ordinal: number }
  | { type: "citation"; citation: CitationDTO }
  /** A quote that was cut off by Stop and discarded. */
  | { type: "cite_drop"; ordinal: number }
  | { type: "step"; step: AgentStep }
  /** A progress line such as "Reading pages 40–60…". */
  | { type: "status"; message: string }
  | { type: "reset"; mode: AnswerMode }
  | { type: "coverage"; coverage: Coverage }
  | { type: "done"; status: MessageStatus; answerStatus: AnswerStatus | null }
  | { type: "error"; message: string };

export const CITE_MARKER = /\[\[cite:(\d+)\]\]/g;
export const citeMarker = (ordinal: number) => `[[cite:${ordinal}]]`;

export interface DocumentDTO {
  id: string;
  name: string;
  kind: DocKind;
  size: number;
  status: "processing" | "ready" | "failed" | "needs_ocr";
  stage: "extracting" | "indexing" | null;
  progressDone: number;
  progressTotal: number;
  pageCount: number | null;
  chunkCount: number;
  unreadablePages: number[];
  errorMessage: string | null;
  createdAt: string;
  chats: { id: string; title: string; updatedAt: string; documentCount: number }[];
  comparisons: { id: string; otherName: string }[];
}

export interface ChatDocumentDTO {
  id: string;
  alias: string;
  name: string;
  kind: DocKind;
  pageCount: number | null;
}

export interface MessageDTO {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  mode: AnswerMode | null;
  answerStatus: AnswerStatus | null;
  coverage: Coverage | null;
  steps: AgentStep[];
  error: string | null;
  citations: CitationDTO[];
  createdAt: string;
}

export interface ChatDTO {
  id: string;
  title: string;
  documents: ChatDocumentDTO[];
  messages: MessageDTO[];
}
