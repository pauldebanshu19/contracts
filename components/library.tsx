"use client";

import {
  AlertTriangle,
  FileText,
  FileType2,
  GitCompareArrows,
  MessageSquare,
  MessagesSquare,
  Plus,
  RotateCcw,
  ScanLine,
  ScrollText,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useRef, useState, type DragEvent } from "react";
import { api, checkFile, uploadFile, type AppConfig } from "@/lib/client/api";
import type { DocumentDTO } from "@/lib/types";
import { Badge, Button, Dialog, IconButton, Spinner, cn, formatBytes, formatDate } from "./ui";

interface Upload {
  key: string;
  name: string;
  sent: number;
  total: number;
  error: string | null;
  cancel?: () => void;
}

interface Props {
  documents: DocumentDTO[] | null;
  loadError: string | null;
  config: AppConfig | null;
  activeChatId: string | null;
  activeCompareId: string | null;
  onChanged: () => void;
  onOpenChat: (id: string) => void;
  onOpenCompare: (id: string) => void;
  onNavigateHome: () => void;
}

/** The library (PRD A1.8): dropzone, documents with status and progress, chats under each document. */
export function Library({ documents, loadError, config, activeChatId, activeCompareId, onChanged, onOpenChat, onOpenCompare, onNavigateHome }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<{ doc: DocumentDTO; chats: { id: string; title: string }[]; comparisons: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const maxMb = config?.maxUploadMb ?? 25;
  const maxDocs = config?.maxDocsPerChat ?? 5;

  const patch = (key: string, change: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
        setUploads((list) => [...list, { key, name: file.name, sent: 0, total: file.size, error: null }]);
        const problem = await checkFile(file, maxMb);
        if (problem) {
          patch(key, { error: problem });
          continue;
        }
        const { promise, cancel } = uploadFile(file, (sent, total) => patch(key, { sent, total }));
        patch(key, { cancel });
        try {
          await promise;
          setUploads((list) => list.filter((u) => u.key !== key));
          onChanged();
        } catch (error) {
          patch(key, { error: error instanceof Error ? error.message : "Upload failed.", cancel: undefined });
        }
      }
    },
    [maxMb, onChanged],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const readyIds = new Set(documents?.filter((d) => d.status === "ready").map((d) => d.id));
  const selection = selected.filter((id) => readyIds.has(id));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const openDocument = (doc: DocumentDTO) =>
    run(async () => {
      const own = doc.chats.find((c) => c.documentCount === 1);
      if (own) return onOpenChat(own.id);
      onOpenChat(await api.createChat([doc.id]));
      onChanged();
    });

  const newChat = (doc: DocumentDTO) =>
    run(async () => {
      onOpenChat(await api.createChat([doc.id]));
      onChanged();
    });

  const askAcross = () =>
    run(async () => {
      onOpenChat(await api.createChat(selection));
      setSelected([]);
      onChanged();
    });

  const compare = () =>
    run(async () => {
      // The first ticked is treated as the earlier version; the comparison screen can swap them.
      onOpenCompare(await api.compare(selection[0], selection[1]));
      setSelected([]);
      onChanged();
    });

  const askDelete = (doc: DocumentDTO) =>
    run(async () => {
      const { dependents } = await api.document(doc.id);
      setDeleting({ doc, chats: dependents.chats, comparisons: dependents.comparisons });
    });

  const confirmDelete = () =>
    run(async () => {
      if (!deleting) return;
      const removedActive = deleting.chats.some((c) => c.id === activeChatId) || deleting.doc.comparisons.some((c) => c.id === activeCompareId);
      await api.deleteDocument(deleting.doc.id);
      setSelected((list) => list.filter((id) => id !== deleting.doc.id));
      setDeleting(null);
      if (removedActive) onNavigateHome();
      onChanged();
    });

  const retry = (doc: DocumentDTO) =>
    run(async () => {
      await api.retryDocument(doc.id);
      onChanged();
    });

  const empty = documents !== null && documents.length === 0 && uploads.length === 0;

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-4 pr-3">
        <button type="button" onClick={onNavigateHome} className="flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white">
            <ScrollText className="h-4 w-4" />
          </span>
          Contract Reader
        </button>
        <Button size="sm" onClick={() => input.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> Upload
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {empty || dragging ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={cn(
            "mx-3 mb-3 flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center transition-colors",
            dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-surface hover:border-accent",
          )}
        >
          <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-text-2">
            <Upload className="h-4 w-4" />
          </span>
          <span className="text-sm font-medium">Drop a contract (PDF or DOCX)</span>
          <span className="mt-1 text-xs leading-relaxed text-text-3">Up to {maxMb} MB. Scanned PDFs need OCR first: they have no text to read.</span>
        </button>
      ) : null}

      {selection.length > 0 ? (
        <div className="mx-3 mb-2 rounded-xl border border-accent/20 bg-accent-soft p-2">
          <div className="flex items-center justify-between pl-1">
            <span className="text-xs font-medium text-accent-text">{selection.length} selected</span>
            <IconButton label="Clear selection" className="h-6 w-6 text-accent-text hover:bg-accent/10 hover:text-accent-text" onClick={() => setSelected([])}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="primary" disabled={busy || selection.length < 2 || selection.length > maxDocs} onClick={askAcross} title={selection.length > maxDocs ? `At most ${maxDocs}` : undefined}>
              <MessagesSquare className="h-3.5 w-3.5" /> Ask across {selection.length}
            </Button>
            <Button size="sm" disabled={busy || selection.length !== 2} onClick={compare} title="Tick exactly two documents">
              <GitCompareArrows className="h-3.5 w-3.5" /> Compare
            </Button>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="mx-3 mb-2 flex items-start gap-2 rounded-lg bg-danger-soft px-2.5 py-2 text-xs text-danger">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button type="button" className="underline" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 [scrollbar-gutter:stable]">
        {documents && documents.length > 0 ? (
          <p className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-text-3">
            Documents <span className="tabular-nums">{documents.length}</span>
          </p>
        ) : null}

        {uploads.map((u) => (
          <UploadRow key={u.key} upload={u} onDismiss={() => setUploads((list) => list.filter((x) => x.key !== u.key))} />
        ))}

        {documents === null && !loadError ? (
          <div className="space-y-2 px-2 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-3/70" />
            ))}
          </div>
        ) : null}
        {loadError ? (
          <p className="m-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{loadError}</p>
        ) : null}

        {documents?.map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            checked={selected.includes(doc.id)}
            activeChatId={activeChatId}
            activeCompareId={activeCompareId}
            onToggle={() => toggle(doc.id)}
            onOpen={() => openDocument(doc)}
            onNewChat={() => newChat(doc)}
            onDelete={() => askDelete(doc)}
            onRetry={() => retry(doc)}
            onOpenChat={onOpenChat}
            onOpenCompare={onOpenCompare}
          />
        ))}
        {documents && documents.length > 0 && selection.length === 0 ? (
          <p className="mt-3 border-t border-border px-2 pt-3 text-[11px] leading-relaxed text-text-3">Tick two to five documents to ask across them, or exactly two versions to compare.</p>
        ) : null}
      </div>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.doc.name ?? ""}"?`}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={confirmDelete}>
              {busy ? <Spinner /> : <Trash2 className="h-4 w-4" />} Delete
            </Button>
          </>
        }
      >
        <p>This deletes the file, its extracted text and its search index{deleting && (deleting.chats.length || deleting.comparisons) ? ", together with:" : "."}</p>
        {deleting && deleting.chats.length > 0 ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {deleting.chats.map((c) => (
              <li key={c.id}>Chat: {c.title}</li>
            ))}
          </ul>
        ) : null}
        {deleting && deleting.comparisons > 0 ? (
          <p className="mt-2">
            {deleting.comparisons} comparison{deleting.comparisons === 1 ? "" : "s"} with other documents.
          </p>
        ) : null}
        <p className="mt-3 text-text-3">This can&apos;t be undone.</p>
      </Dialog>
    </div>
  );
}

function UploadRow({ upload, onDismiss }: { upload: Upload; onDismiss: () => void }) {
  const percent = upload.total ? Math.round((upload.sent / upload.total) * 100) : 0;
  return (
    <div className={cn("mb-1 rounded-lg px-2.5 py-2", upload.error ? "bg-danger-soft" : "border border-border bg-surface")}>
      <div className="flex items-center gap-2">
        {upload.error ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger" /> : <Spinner className="text-text-2" />}
        <span className="min-w-0 flex-1 truncate text-sm">{upload.name}</span>
        {upload.error ? (
          <IconButton label="Dismiss" onClick={onDismiss}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        ) : upload.cancel ? (
          <IconButton label="Cancel upload" onClick={upload.cancel}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        ) : null}
      </div>
      {upload.error ? (
        <p className="mt-1 pl-6 text-xs text-danger">{upload.error} Nothing was added to the library.</p>
      ) : (
        <>
          <p className="mt-1 pl-6 text-xs text-text-2">
            Uploading {formatBytes(upload.sent)} of {formatBytes(upload.total)}
          </p>
          <div className="ml-6 mt-1 h-1 overflow-hidden rounded bg-border">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

function progressText(doc: DocumentDTO): string {
  if (doc.stage === "indexing") return "Indexing sections…";
  if (doc.progressTotal > 0) return `Extracting text, page ${doc.progressDone} of ${doc.progressTotal}`;
  return doc.kind === "docx" ? "Extracting text…" : "Opening the PDF…";
}

function DocumentRow({
  doc,
  checked,
  activeChatId,
  activeCompareId,
  onToggle,
  onOpen,
  onNewChat,
  onDelete,
  onRetry,
  onOpenChat,
  onOpenCompare,
}: {
  doc: DocumentDTO;
  checked: boolean;
  activeChatId: string | null;
  activeCompareId: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onNewChat: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onOpenChat: (id: string) => void;
  onOpenCompare: (id: string) => void;
}) {
  const ready = doc.status === "ready";
  const Icon = doc.kind === "pdf" ? FileText : FileType2;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const size = doc.kind === "pdf" ? (doc.pageCount ? plural(doc.pageCount, "page") : null) : doc.chunkCount ? plural(doc.chunkCount, "section") : null;
  const meta = [doc.kind.toUpperCase(), size, formatDate(doc.createdAt)].filter(Boolean).join(" · ");

  return (
    <div className="mb-1">
      <div className={cn("group relative flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors", ready && "hover:bg-surface-3", checked && "bg-surface-3")}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!ready}
          onChange={onToggle}
          aria-label={`Select ${doc.name}`}
          className={cn("check mt-0.5", !ready && "invisible")}
        />
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", !ready ? "text-text-3" : doc.kind === "pdf" ? "text-danger/70" : "text-accent/80")} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            disabled={!ready}
            onClick={onOpen}
            className="line-clamp-2 block w-full text-left text-[13px] font-medium leading-5 [overflow-wrap:anywhere] enabled:hover:text-accent-text disabled:cursor-default disabled:text-text-2"
            title={doc.name}
          >
            {doc.name}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-text-3">
            <span>{meta}</span>
            {doc.status === "processing" ? <Badge tone="accent">Processing</Badge> : null}
            {doc.status === "failed" ? <Badge tone="danger">Failed</Badge> : null}
            {doc.status === "needs_ocr" ? (
              <Badge tone="unverified">
                <ScanLine className="h-3 w-3" /> Needs OCR
              </Badge>
            ) : null}
            {ready && doc.unreadablePages.length ? (
              <Badge tone="unverified">{doc.unreadablePages.length} unreadable page{doc.unreadablePages.length === 1 ? "" : "s"}</Badge>
            ) : null}
          </div>

          {doc.status === "processing" ? (
            <div className="mt-1.5">
              <p className="flex items-center gap-1.5 text-xs text-text-2">
                <Spinner className="h-3 w-3" /> {progressText(doc)}
              </p>
              {doc.progressTotal > 0 && doc.stage === "extracting" ? (
                <div className="mt-1 h-1 overflow-hidden rounded bg-border">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${(doc.progressDone / doc.progressTotal) * 100}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}

          {doc.status === "failed" || doc.status === "needs_ocr" ? (
            <div className="mt-1.5">
              <p className="text-xs leading-[1.45] text-text-2">{doc.errorMessage}</p>
              <div className="-ml-2 mt-1 flex gap-0.5">
                {doc.status === "failed" ? (
                  <Button size="sm" variant="ghost" onClick={onRetry}>
                    <RotateCcw className="h-3 w-3" /> Retry
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={onDelete}>
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        {ready ? (
          // Laid over the end of the name, so the name keeps the full width of the row.
          <div className="absolute right-1 top-1 hidden rounded-md bg-surface-3 shadow-[-10px_0_8px_var(--surface-3)] group-focus-within:flex group-hover:flex">
            <IconButton label="New chat" className="hover:bg-border" onClick={onNewChat}>
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label="Delete" className="hover:bg-border" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ) : null}
      </div>

      {ready && (doc.chats.length > 0 || doc.comparisons.length > 0) ? (
        <ul className="mb-2 ml-[41px] mt-0.5 space-y-px border-l border-border pl-1.5">
          {doc.chats.map((chat) => (
            <li key={chat.id}>
              <button type="button" onClick={() => onOpenChat(chat.id)} aria-current={chat.id === activeChatId ? "page" : undefined} className={linkClass(chat.id === activeChatId)}>
                {chat.documentCount > 1 ? <MessagesSquare className="h-3.5 w-3.5 shrink-0 opacity-70" /> : <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />}
                <span className="truncate">{chat.title}</span>
                {chat.documentCount > 1 ? <span className="ml-auto shrink-0 pl-1 text-[11px] font-normal opacity-60">{chat.documentCount} docs</span> : null}
              </button>
            </li>
          ))}
          {doc.comparisons.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpenCompare(c.id)} aria-current={c.id === activeCompareId ? "page" : undefined} className={linkClass(c.id === activeCompareId)}>
                <GitCompareArrows className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">Compared with {c.otherName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A chat or comparison nested under its document. */
function linkClass(active: boolean): string {
  return cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[12.5px] leading-5 transition-colors",
    active ? "bg-accent-soft font-medium text-accent-text" : "text-text-2 hover:bg-surface-3 hover:text-text",
  );
}
