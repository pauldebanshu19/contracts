"use client";

import { extensionOf, sniff } from "../ingest/sniff";
import type { ChatDTO, DocumentDTO, StreamEvent } from "../types";

/** Browser-side calls to the API. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status}).`, response.status);
  return body as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface AppConfig {
  maxUploadMb: number;
  maxDocsPerChat: number;
  llmConfigured: boolean;
  model: string | null;
  voiceConfigured: boolean;
  /** Research mode is off by default when the model's rate limit would make it slow. */
  researchDefault: boolean;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  documents: () => request<{ documents: DocumentDTO[] }>("/api/documents").then((r) => r.documents),
  document: (id: string) =>
    request<{ document: DocumentDTO; dependents: { chats: { id: string; title: string }[]; comparisons: number } }>(`/api/documents/${id}`),
  deleteDocument: (id: string) => request<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),
  retryDocument: (id: string) => request<{ document: DocumentDTO }>(`/api/documents/${id}/retry`, { method: "POST" }),
  createChat: (documentIds: string[]) => request<{ id: string }>("/api/chats", json({ documentIds })).then((r) => r.id),
  chat: (id: string) => request<{ chat: ChatDTO }>(`/api/chats/${id}`).then((r) => r.chat),
  deleteChat: (id: string) => request<{ ok: true }>(`/api/chats/${id}`, { method: "DELETE" }),
  compare: (a: string, b: string) => request<{ id: string }>("/api/comparisons", json({ a, b })).then((r) => r.id),
};


export async function checkFile(file: File, maxUploadMb: number): Promise<string | null> {
  const ext = extensionOf(file.name);
  if (ext !== "pdf" && ext !== "docx") return "This isn't a PDF or Word file.";
  if (file.size > maxUploadMb * 1024 * 1024) return `This file is larger than ${maxUploadMb} MB.`;
  if (file.size === 0) return "This file is empty.";
  // The signature check needs the start of the file, and for a .docx the ZIP directory at the end.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = sniff(file.name, bytes);
  return result.ok ? null : result.message;
}

/** Upload with byte progress. XMLHttpRequest, because fetch can't report upload progress. */
export function uploadFile(
  file: File,
  onProgress: (sent: number, total: number) => void,
): { promise: Promise<DocumentDTO>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<DocumentDTO>((resolve, reject) => {
    xhr.open("POST", "/api/documents");
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      let body: { document?: DocumentDTO; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the generic message
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.document) resolve(body.document);
      else if (xhr.status === 413 && !body.error) reject(new ApiError("This file is larger than the server accepts.", 413));
      else reject(new ApiError(body.error ?? `Upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("The upload was interrupted. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}

/** Send a recorded question to be transcribed. */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const body = await request<{ text: string }>("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
    signal,
  });
  return body.text;
}

/** Ask a question and receive the answer as parsed SSE events. Resolves when the stream ends. */
export async function streamAnswer(
  chatId: string,
  question: string,
  research: boolean,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/chats/${chatId}/messages`, { ...json({ question, research }), signal });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? `The question couldn't be sent (${response.status}).`, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
