"use client";

import { AlertTriangle, ArrowUp, FileText, FlaskConical, MessageSquareQuote, Square } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, api, streamAnswer, type AppConfig } from "@/lib/client/api";
import type { ChatDTO, CitationDTO, MessageDTO, StreamEvent } from "@/lib/types";
import type { ViewerTarget } from "../viewer/types";
import { Button, DocBadge, Spinner, cn } from "../ui";
import { AssistantMessage, type AnswerView } from "./message";
import { VoiceButton } from "./voice-button";

// pdf.js and the DOM range code only run in the browser.
const DocumentViewer = dynamic(() => import("../viewer/document-viewer").then((m) => m.DocumentViewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-text-2">
      <Spinner /> <span className="ml-2">Opening viewer…</span>
    </div>
  ),
});

/** The research-mode choice, kept per browser: "1", "0", or null when the reader hasn't chosen. */
const researchListeners = new Set<() => void>();
const researchStore = {
  subscribe(listener: () => void) {
    researchListeners.add(listener);
    return () => researchListeners.delete(listener);
  },
  get(): string | null {
    try {
      return window.localStorage.getItem("research-mode");
    } catch {
      return null;
    }
  },
  set(value: boolean) {
    try {
      window.localStorage.setItem("research-mode", value ? "1" : "0");
    } catch {
      // storage unavailable: the choice lasts until reload
    }
    researchListeners.forEach((l) => l());
  },
};

const STARTERS_ONE = ["What is the notice period for termination?", "What is the liability cap?", "Which law governs this contract?"];
const STARTERS_MANY = ["How do the liability caps compare?", "How do the termination rights differ?", "Which law governs each document?"];

/** The measure shared by the conversation and the composer below it. */
const COLUMN = "mx-auto w-full max-w-[50rem] px-6";

function toView(message: MessageDTO): AnswerView {
  return {
    content: message.content,
    citations: Object.fromEntries(message.citations.map((c) => [c.ordinal, c])),
    pending: [],
    steps: message.steps,
    status: message.status,
    mode: message.mode,
    answerStatus: message.answerStatus,
    coverage: message.coverage,
    error: message.error,
  };
}

const emptyLive = (): AnswerView => ({
  content: "",
  citations: {},
  pending: [],
  steps: [],
  status: "streaming",
  mode: null,
  answerStatus: null,
  coverage: null,
  error: null,
  statusLine: null,
});

/** Apply one stream event to the answer being written. */
function reduce(view: AnswerView, event: StreamEvent): AnswerView {
  switch (event.type) {
    case "text":
      return { ...view, content: view.content + event.text };
    case "cite_pending":
      return { ...view, content: `${view.content}[[cite:${event.ordinal}]]`, pending: [...view.pending, event.ordinal] };
    case "citation":
      return {
        ...view,
        citations: { ...view.citations, [event.citation.ordinal]: event.citation },
        pending: view.pending.filter((o) => o !== event.citation.ordinal),
      };
    case "cite_drop":
      return { ...view, content: view.content.replace(`[[cite:${event.ordinal}]]`, ""), pending: view.pending.filter((o) => o !== event.ordinal) };
    case "step": {
      const steps = view.steps.some((s) => s.id === event.step.id)
        ? view.steps.map((s) => (s.id === event.step.id ? event.step : s))
        : [...view.steps, event.step];
      return { ...view, steps };
    }
    case "status":
      return { ...view, statusLine: event.message };
    case "reset":
      return { ...view, content: "", citations: {}, pending: [], mode: event.mode };
    case "coverage":
      return { ...view, coverage: event.coverage };
    case "done":
      return { ...view, status: event.status, answerStatus: event.answerStatus, statusLine: null };
    case "error":
      return { ...view, error: event.message };
    default:
      return view;
  }
}

export function ChatView({ chatId, config, onChanged, onMissing }: { chatId: string; config: AppConfig | null; onChanged: () => void; onMissing: () => void }) {
  const [chat, setChat] = useState<ChatDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<{ question: string; answer: AnswerView } | null>(null);
  const [draft, setDraft] = useState("");
  const researchChoice = useSyncExternalStore(researchStore.subscribe, researchStore.get, () => null);
  // Without a choice of their own, the server's default applies (off when the model's rate limit would make research slow).
  const research = researchChoice === null ? (config?.researchDefault ?? true) : researchChoice === "1";
  const [sendError, setSendError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const opened = useRef(0);
  // Parent callbacks may change identity on every render; effects must not re-run (and abort an answer) because of that.
  const onMissingRef = useRef(onMissing);
  const onChangedRef = useRef(onChanged);
  useLayoutEffect(() => {
    onMissingRef.current = onMissing;
    onChangedRef.current = onChanged;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.chat(chatId);
      setChat(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) onMissingRef.current();
      else setLoadError(error instanceof Error ? error.message : "Couldn't load this chat.");
      return null;
    }
  }, [chatId]);

  useEffect(() => {
    let cancelled = false;
    api.chat(chatId).then(
      (next) => !cancelled && setChat(next),
      (error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) onMissingRef.current();
        else setLoadError(error instanceof Error ? error.message : "Couldn't load this chat.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Leaving the chat (it is keyed by id, so this is unmount) stops an answer in progress; the server saves it as stopped.
  useEffect(() => () => abortRef.current?.abort(), []);

  // An answer stopped a moment ago may still be saving on the server; look again shortly.
  useEffect(() => {
    if (live || !chat?.messages.some((m) => m.status === "streaming")) return;
    const timer = setTimeout(() => void refresh(), 800);
    return () => clearTimeout(timer);
  }, [chat, live, refresh]);

  // Keep the newest text in view unless the reader has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [chat, live]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Esc stops generation (PRD A2.2).
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, stop]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      followRef.current = true;
      setDraft("");
      setSendError(null);
      setLive({ question, answer: emptyLive() });

      try {
        await streamAnswer(chatId, question, research, controller.signal, (event) =>
          setLive((current) => (current ? { ...current, answer: reduce(current.answer, event) } : current)),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          // Nothing was saved if the request was refused before streaming; put the question back.
          const refusedBeforeStart = error instanceof ApiError;
          if (refusedBeforeStart) {
            setDraft(question);
            setSendError(error.message);
            setLive(null);
          } else {
            setLive((current) => (current ? { ...current, answer: { ...current.answer, status: "error", error: "The connection to the server was lost." } } : current));
          }
        }
      } finally {
        abortRef.current = null;
        await refresh();
        setLive(null);
        onChangedRef.current();
        inputRef.current?.focus();
      }
    },
    [chatId, research, refresh],
  );

  const openCitation = useCallback(
    (citation: CitationDTO) => {
      if (!citation.documentId || !citation.verified) return;
      setViewer({
        documentId: citation.documentId,
        matches: citation.matches.map((m) => ({ segments: m.segments.map((s) => ({ start: s.start, end: s.end })) })),
        primary: Math.max(0, citation.primary),
        displayText: citation.displayText,
        key: `${citation.documentId}-${citation.ordinal}-${++opened.current}`,
      });
    },
    [],
  );

  if (loadError && !chat) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="flex items-center gap-2 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {loadError}
          <Button size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-2">
        <Spinner /> <span className="ml-2">Loading chat…</span>
      </div>
    );
  }

  const many = chat.documents.length > 1;
  const streaming = live !== null;
  const messages = chat.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const viewerDoc = viewer ? chat.documents.find((d) => d.id === viewer.documentId) : null;
  const noModel = config && !config.llmConfigured;

  return (
    <div className="flex h-full min-h-0">
      <section className={cn("flex min-w-0 flex-col bg-surface", viewer ? "w-[46%] border-r border-border" : "flex-1")}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
          <h1 className="max-w-[55%] shrink-0 truncate text-[15px] font-semibold tracking-tight" title={chat.title}>
            {chat.title}
          </h1>
          {/* One row at any width: the names shorten before anything wraps, so this header stays level with the viewer's. */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {many ? (
              chat.documents.map((d) => <DocBadge key={d.id} alias={d.alias} name={d.name} />)
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-2" title={chat.documents[0]?.name}>
                <FileText className="h-3.5 w-3.5 shrink-0 text-text-3" />
                <span className="truncate">{chat.documents[0]?.name}</span>
              </span>
            )}
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {/* The conversation keeps a readable measure however wide the pane is. */}
          <div className={cn(COLUMN, "flex min-h-full flex-col pb-6 pt-8")}>
            {messages.length === 0 && !live ? (
              <div className="m-auto w-full max-w-md pb-8 text-center">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <MessageSquareQuote className="h-5 w-5" />
                </span>
                <h2 className="mt-4 text-lg font-semibold tracking-tight">{many ? `Ask across ${chat.documents.length} documents` : "Ask about this contract"}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-text-2">
                  {many
                    ? "Each quote in the answer is labelled with the document it comes from."
                    : "Every quote in the answer is checked against the document."}
                </p>
                <div className="mt-6 flex flex-col gap-2">
                  {(many ? STARTERS_MANY : STARTERS_ONE).map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={Boolean(noModel)}
                      onClick={() => void send(q)}
                      className="group flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-left text-sm transition-colors enabled:hover:border-accent/50 enabled:hover:bg-accent-soft/60 disabled:opacity-50"
                    >
                      {q}
                      <ArrowUp className="h-4 w-4 shrink-0 rotate-45 text-text-3 transition-colors group-hover:text-accent" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-7">
              {messages.map((message) =>
                message.role === "user" ? (
                  <UserBubble key={message.id} text={message.content} />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    answer={toView(message)}
                    documents={chat.documents}
                    onOpenCitation={openCitation}
                    onRetry={message.status === "error" && message === messages[messages.length - 1] && lastUser ? () => void send(lastUser.content) : undefined}
                  />
                ),
              )}
              {live ? (
                <>
                  <UserBubble text={live.question} />
                  <AssistantMessage answer={live.answer} documents={chat.documents} onOpenCitation={openCitation} />
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* No rule above the composer: the conversation fades out under it instead. */}
        <footer className={cn(COLUMN, "relative shrink-0 pb-3 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-t before:from-surface before:to-transparent")}>
          {noModel ? (
            <p className="mb-2 rounded-lg bg-unverified-soft px-3.5 py-2 text-xs text-unverified">
              No model is configured on the server, so questions can&apos;t be answered yet. Set LLM_API_KEY and LLM_MODEL and restart.
            </p>
          ) : null}
          {sendError ? (
            <p role="alert" className="mb-2 flex items-center gap-2 rounded-lg bg-danger-soft px-3.5 py-2 text-xs text-danger">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {sendError}
            </p>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            // A click on the box's padding or toolbar still lands in the question.
            onClick={(e) => {
              if (e.target === e.currentTarget) inputRef.current?.focus();
            }}
            className="cursor-text rounded-2xl border border-border-strong bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10"
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter adds a line.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={Math.min(6, Math.max(1, draft.split("\n").length))}
              placeholder={many ? `Ask across ${chat.documents.length} documents…` : "Ask about this contract…"}
              disabled={Boolean(noModel)}
              className="block max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 outline-none placeholder:text-text-3"
              aria-label="Question"
            />
            <div className="pointer-events-none flex items-center gap-1.5 px-2.5 pb-2.5 pt-1 *:pointer-events-auto">
              <button
                type="button"
                role="switch"
                aria-checked={research}
                onClick={() => researchStore.set(!research)}
                title="The model reads the contract step by step with search and read tools. Off: one targeted search."
                className={cn(
                  "mr-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                  research ? "border-accent/30 bg-accent-soft text-accent-text" : "border-border text-text-2 hover:bg-surface-2 hover:text-text",
                )}
              >
                <FlaskConical className="h-3.5 w-3.5" /> Research mode
              </button>
              {config?.voiceConfigured ? (
                <VoiceButton
                  disabled={streaming || Boolean(noModel)}
                  onError={setSendError}
                  onTranscript={(text) => {
                    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
                    inputRef.current?.focus();
                  }}
                />
              ) : null}
              {streaming ? (
                <Button variant="secondary" className="h-8 rounded-full px-3 text-xs" onClick={stop} title="Stop (Esc)">
                  <Square className="h-3 w-3 fill-current" /> Stop
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  className="h-8 w-8 rounded-full px-0 disabled:bg-surface-2 disabled:text-text-3"
                  disabled={!draft.trim() || Boolean(noModel)}
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>
          </form>
          <p className="mt-2 text-center text-[11px] text-text-3">{streaming ? "Esc to stop" : "Enter to send · Shift+Enter for a new line"}</p>
        </footer>
      </section>

      {viewer && viewerDoc ? (
        <section className="min-w-0 flex-1 bg-surface-2">
          <DocumentViewer key={viewer.key} target={viewer} document={viewerDoc} onClose={() => setViewer(null)} />
        </section>
      ) : null}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-text">{text}</p>
    </div>
  );
}
