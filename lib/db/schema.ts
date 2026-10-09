import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Clause } from "../text/segment";
import type { Segment } from "../text/normalize";
import type { AgentStep, Coverage, StoredMatch } from "../types";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/*
 * Every table has row-level security switched on and no policies. The server connects as the
 * tables' owner, which row-level security doesn't apply to, so nothing changes for it. Any other
 * database role gets no rows. That matters on hosts such as Supabase, which put a public REST API in
 * front of the database and grant its roles full access to new tables: without this, uploaded
 * contracts would be readable through that API.
 */

export type DocumentStatus = "processing" | "ready" | "failed" | "needs_ocr";
export type DocumentStage = "extracting" | "indexing";

export const documents = pgTable("documents", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").$type<"pdf" | "docx">().notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").$type<DocumentStatus>().notNull().default("processing"),
  stage: text("stage").$type<DocumentStage>(),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  /** Null for DOCX, which has no fixed pages. */
  pageCount: integer("page_count"),
  chunkCount: integer("chunk_count").notNull().default(0),
  unreadablePages: jsonb("unreadable_pages").$type<number[]>().notNull().default([]),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
}).enableRLS();

export const documentContent = pgTable("document_content", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  file: bytea("file").notNull(),
  /** Sanitised HTML, DOCX only. The viewer renders this and the text below is read from it. */
  html: text("html"),
  /** The canonical text every offset refers to. */
  text: text("text"),
  /** Normalised key and its map back to `text`, computed once at ingestion. */
  key: text("key"),
  keyMap: bytea("key_map"),
  /** Source map: the text range of each PDF page. */
  pages: jsonb("pages").$type<Segment[]>(),
  itemCounts: jsonb("item_counts").$type<number[]>(),
  boilerplate: jsonb("boilerplate").$type<Segment[]>(),
  clauses: jsonb("clauses").$type<Clause[]>(),
}).enableRLS();

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    section: text("section").notNull().default(""),
    heading: text("heading").notNull().default(""),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    text: text("text").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', coalesce(${chunks.heading}, '') || ' ' || ${chunks.text})`,
    ),
  },
  (t) => [index("chunks_document_ordinal").on(t.documentId, t.ordinal), index("chunks_tsv").using("gin", t.tsv)],
).enableRLS();

export const chats = pgTable("chats", {
  id: id(),
  title: text("title").notNull().default("New chat"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const chatDocuments = pgTable(
  "chat_documents",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** D1…Dn, in the order the documents were selected. */
    alias: text("alias").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.documentId] }), index("chat_documents_document").on(t.documentId)],
).enableRLS();

export type MessageStatus = "streaming" | "complete" | "stopped" | "error";
export type AnswerMode = "targeted" | "full_scan" | "research";

export const messages = pgTable(
  "messages",
  {
    id: id(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    /** Answer text with [[cite:n]] markers where quotes belong. Never contains quote text. */
    content: text("content").notNull().default(""),
    status: text("status").$type<MessageStatus>().notNull().default("complete"),
    mode: text("mode").$type<AnswerMode>(),
    answerStatus: text("answer_status").$type<"answered" | "partial" | "not_found">(),
    coverage: jsonb("coverage").$type<Coverage>(),
    steps: jsonb("steps").$type<AgentStep[]>().notNull().default([]),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_chat").on(t.chatId, t.createdAt)],
).enableRLS();

export const citations = pgTable(
  "citations",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Position in the answer; matches the [[cite:n]] marker. */
    ordinal: integer("ordinal").notNull(),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    alias: text("alias"),
    modelQuote: text("model_quote").notNull(),
    displayText: text("display_text").notNull(),
    verified: boolean("verified").notNull(),
    reason: text("reason"),
    reasonText: text("reason_text"),
    matches: jsonb("matches").$type<StoredMatch[]>().notNull().default([]),
    primaryMatch: integer("primary_match").notNull().default(-1),
  },
  (t) => [index("citations_message").on(t.messageId, t.ordinal)],
).enableRLS();

export type ComparisonStatus = "processing" | "ready" | "failed";

export const comparisons = pgTable("comparisons", {
  id: id(),
  docA: uuid("doc_a")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  docB: uuid("doc_b")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  status: text("status").$type<ComparisonStatus>().notNull().default("processing"),
  stage: text("stage"),
  /** The 3–7 changes that matter most, in plain language. */
  summary: jsonb("summary").$type<string[]>(),
  /** Set when the model step failed and the list shows rule-based results only. */
  notice: text("notice"),
  error: text("error"),
  createdAt: createdAt(),
}).enableRLS();

export type ChangeType = "cosmetic" | "modified" | "added" | "removed" | "moved";
export type Significance = "high" | "medium" | "low" | "cosmetic";

export const comparisonChanges = pgTable(
  "comparison_changes",
  {
    id: id(),
    comparisonId: uuid("comparison_id")
      .notNull()
      .references(() => comparisons.id, { onDelete: "cascade" }),
    /** Document order, by the newer version where the clause exists there. */
    ordinal: integer("ordinal").notNull(),
    type: text("type").$type<ChangeType>().notNull(),
    significance: text("significance").$type<Significance>().notNull(),
    /** The floor set by rules before any model call. The model can raise it, never lower it. */
    floor: text("floor").$type<Significance>().notNull(),
    floorReasons: jsonb("floor_reasons").$type<string[]>().notNull().default([]),
    category: text("category").notNull().default("other"),
    summary: text("summary").notNull().default(""),
    aNumber: text("a_number"),
    aHeading: text("a_heading"),
    aStart: integer("a_start"),
    aEnd: integer("a_end"),
    bNumber: text("b_number"),
    bHeading: text("b_heading"),
    bStart: integer("b_start"),
    bEnd: integer("b_end"),
  },
  (t) => [index("comparison_changes_comparison").on(t.comparisonId, t.ordinal)],
).enableRLS();

export type JobType = "ingest" | "compare";
export type JobStatus = "queued" | "running" | "done" | "failed";

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").$type<JobType>().notNull(),
    targetId: uuid("target_id").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status").on(t.status, t.createdAt)],
).enableRLS();
