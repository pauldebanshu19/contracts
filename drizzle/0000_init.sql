CREATE TABLE "chat_documents" (
	"chat_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "chat_documents_chat_id_document_id_pk" PRIMARY KEY("chat_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"page_from" integer,
	"page_to" integer,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("chunks"."heading", '') || ' ' || "chunks"."text")) STORED
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"document_id" uuid,
	"alias" text,
	"model_quote" text NOT NULL,
	"display_text" text NOT NULL,
	"verified" boolean NOT NULL,
	"reason" text,
	"reason_text" text,
	"matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_match" integer DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparison_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comparison_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"significance" text NOT NULL,
	"floor" text NOT NULL,
	"floor_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"a_number" text,
	"a_heading" text,
	"a_start" integer,
	"a_end" integer,
	"b_number" text,
	"b_heading" text,
	"b_start" integer,
	"b_end" integer
);
--> statement-breakpoint
CREATE TABLE "comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_a" uuid NOT NULL,
	"doc_b" uuid NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"stage" text,
	"summary" jsonb,
	"notice" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_content" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"file" "bytea" NOT NULL,
	"html" text,
	"text" text,
	"key" text,
	"key_map" "bytea",
	"pages" jsonb,
	"item_counts" jsonb,
	"boilerplate" jsonb,
	"clauses" jsonb
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"stage" text,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"page_count" integer,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"unreadable_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"mode" text,
	"answer_status" text,
	"coverage" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_changes" ADD CONSTRAINT "comparison_changes_comparison_id_comparisons_id_fk" FOREIGN KEY ("comparison_id") REFERENCES "public"."comparisons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_doc_a_documents_id_fk" FOREIGN KEY ("doc_a") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_doc_b_documents_id_fk" FOREIGN KEY ("doc_b") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_content" ADD CONSTRAINT "document_content_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_documents_document" ON "chat_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_document_ordinal" ON "chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_tsv" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "citations_message" ON "citations" USING btree ("message_id","ordinal");--> statement-breakpoint
CREATE INDEX "comparison_changes_comparison" ON "comparison_changes" USING btree ("comparison_id","ordinal");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "messages_chat" ON "messages" USING btree ("chat_id","created_at");