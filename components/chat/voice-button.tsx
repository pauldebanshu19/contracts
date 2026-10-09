"use client";

import { Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio } from "@/lib/client/api";
import { Spinner, cn } from "../ui";

/**
 * Voice input: click to record, click again to stop. The recording is
 * transcribed on the server (Deepgram) and the text goes into the question box,
 * so it can be checked before sending: a misheard number would change the question.
 */

const MAX_SECONDS = 90;

/** The first recording format this browser supports. Safari records MP4, the others WebM or Ogg. */
function recordingType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
}

function micError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it for this site in the browser's settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return "The microphone couldn't be started.";
}

type State = "idle" | "starting" | "recording" | "transcribing";

export function VoiceButton({
  disabled,
  onTranscript,
  onError,
}: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
}) {
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const request = useRef<AbortController | null>(null);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const stop = useCallback((cancel = false) => {
    cancelled.current = cancel;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  // Release the microphone and drop any transcription in flight when the chat goes away.
  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      request.current?.abort();
      release();
    },
    [release],
  );

  // Esc discards a recording in progress.
  useEffect(() => {
    if (state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stop(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, stop]);

  const start = async () => {
    onError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Voice input needs a browser with microphone support, on HTTPS or localhost.");
      return;
    }
    setState("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      setState("idle");
      onError(micError(error));
      return;
    }

    const type = recordingType();
    const rec = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    recorder.current = rec;
    chunks.current = [];
    cancelled.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = async () => {
      release();
      if (cancelled.current) {
        setState("idle");
        return;
      }
      const audio = new Blob(chunks.current, { type: rec.mimeType || type || "audio/webm" });
      setState("transcribing");
      const controller = new AbortController();
      request.current = controller;
      try {
        const text = await transcribeAudio(audio, controller.signal);
        onTranscript(text);
      } catch (error) {
        if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "Transcription failed.");
      } finally {
        request.current = null;
        setState("idle");
      }
    };
    rec.start(250);
    setSeconds(0);
    setState("recording");
    const began = Date.now();
    timer.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
  };

  if (state === "recording") {
    return (
      <div className="flex items-center gap-1">
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-danger-soft px-3 text-xs font-medium tabular-nums text-danger" aria-live="polite">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
        <button
          type="button"
          onClick={() => stop(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-2 hover:bg-surface-2"
          aria-label="Discard recording (Esc)"
          title="Discard recording (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => stop()}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-danger px-3 text-xs font-medium text-white hover:bg-danger/90"
          title="Stop and transcribe"
        >
          <Square className="h-3 w-3 fill-current" /> Done
        </button>
      </div>
    );
  }

  const busy = state === "starting" || state === "transcribing";
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled || busy}
      className={cn(
        "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-full px-2 text-sm text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50",
      )}
      aria-label={state === "transcribing" ? "Transcribing" : "Ask by voice"}
      title="Ask by voice"
    >
      {busy ? <Spinner /> : <Mic className="h-4 w-4" />}
      {state === "transcribing" ? <span className="text-xs">Transcribing…</span> : null}
    </button>
  );
}
