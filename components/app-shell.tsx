"use client";

import { FileSearch, Quote, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type AppConfig } from "@/lib/client/api";
import type { DocumentDTO } from "@/lib/types";
import { ChatView } from "./chat/chat-view";
import { CompareView } from "./compare/compare-view";
import { Library } from "./library";


export function AppShell() {
  const params = useSearchParams();
  const router = useRouter();
  const chatId = params.get("chat");
  const compareId = params.get("compare");

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped whenever something changed, to reload the library now instead of at the next poll.
  const [poke, setPoke] = useState(0);
  const kick = useCallback(() => setPoke((n) => n + 1), []);

  useEffect(() => {
    api.config().then(setConfig, () => setConfig(null));
  }, []);

  // Poll quickly while anything is processing, slowly otherwise, so progress survives a refresh (A1.4).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: DocumentDTO[] | null = null;
      try {
        next = await api.documents();
        if (cancelled) return;
        setDocuments(next);
        setLoadError(null);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Couldn't load the library.");
      }
      const busy = next?.some((d) => d.status === "processing");
      timer = setTimeout(tick, busy ? 1200 : next ? 15_000 : 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [poke]);

  const go = useCallback((query: string) => router.push(query ? `/?${query}` : "/"), [router]);
  const goHome = useCallback(() => go(""), [go]);
  const openChat = useCallback((id: string) => go(`chat=${id}`), [go]);
  const openCompare = useCallback((id: string) => go(`compare=${id}`), [go]);

  return (
    <div className="flex h-full min-w-[1024px]">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-border bg-bg">
        <Library
          documents={documents}
          loadError={loadError}
          config={config}
          activeChatId={chatId}
          activeCompareId={compareId}
          onChanged={kick}
          onOpenChat={openChat}
          onOpenCompare={openCompare}
          onNavigateHome={goHome}
        />
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col bg-surface">
        {compareId ? (
          <CompareView key={compareId} id={compareId} onOpenComparison={openCompare} />
        ) : chatId ? (
          <ChatView key={chatId} chatId={chatId} config={config} onChanged={kick} onMissing={goHome} />
        ) : (
          <Welcome hasDocuments={Boolean(documents?.length)} llmConfigured={config?.llmConfigured ?? true} />
        )}
      </main>
    </div>
  );
}

function Welcome({ hasDocuments, llmConfigured }: { hasDocuments: boolean; llmConfigured: boolean }) {
  return (
    <div className="flex h-full overflow-y-auto p-10">
      <div className="m-auto max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Ask a contract, get quotes you can check</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-text-2">
          {hasDocuments
            ? "Open a document on the left to start a chat, tick two to five to ask across them, or tick two versions to compare."
            : "Drop a PDF or Word contract on the left. Text is extracted, indexed and ready to question in under a minute."}
        </p>
        <ul className="mt-8 divide-y divide-border rounded-xl border border-border text-sm leading-relaxed text-text-2">
          <li className="flex gap-3.5 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-verified-soft text-verified">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <span>
              <strong className="block font-medium text-text">Every quote is checked in code</strong>
              It is shown as verified only if it is found word for word in the document, and then in the document&apos;s own words.
            </span>
          </li>
          <li className="flex gap-3.5 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Quote className="h-4 w-4" />
            </span>
            <span>
              <strong className="block font-medium text-text">Click a quote to see it in place</strong>
              The document opens beside the chat with the passage highlighted on the page.
            </span>
          </li>
          <li className="flex gap-3.5 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-2">
              <FileSearch className="h-4 w-4" />
            </span>
            <span>
              <strong className="block font-medium text-text">&ldquo;Not in the document&rdquo; is only said after every page was read</strong>
              Each answer says how much of the document it is based on.
            </span>
          </li>
        </ul>
        {!llmConfigured ? (
          <p className="mt-6 rounded-lg bg-unverified-soft px-3.5 py-2.5 text-sm text-unverified">
            No model is configured on the server yet. Documents can be uploaded and compared by rules, but questions need LLM_API_KEY and LLM_MODEL.
          </p>
        ) : null}
      </div>
    </div>
  );
}
