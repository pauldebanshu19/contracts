import { config } from "../config";

/**
 * Speech to text for voice questions, through Deepgram's pre-recorded API.
 * The browser records a clip and sends it here; the API key never leaves the server.
 */

/** Contract vocabulary that general speech models often mishear. Nova-3 biases recognition towards these. */
const KEYTERMS = [
  "indemnity",
  "indemnification",
  "force majeure",
  "liquidated damages",
  "consequential loss",
  "governing law",
  "termination for convenience",
  "limitation of liability",
  "non-compete",
  "non-solicitation",
  "warranty",
  "arbitration",
  "assignment",
  "confidentiality",
  "AED",
];

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

export interface Transcript {
  text: string;
  confidence: number;
  seconds: number;
}

export async function transcribe(audio: Uint8Array, contentType: string, signal?: AbortSignal): Promise<Transcript> {
  const c = config();
  if (!c.DEEPGRAM_API_KEY) throw new TranscriptionError("Voice input isn't configured on the server.", 503);

  const params = new URLSearchParams({ model: c.DEEPGRAM_MODEL, smart_format: "true", punctuate: "true", language: "en" });
  // Keyterm prompting is a Nova-3 feature; other models reject the parameter.
  if (c.DEEPGRAM_MODEL.startsWith("nova-3")) for (const term of KEYTERMS) params.append("keyterm", term);

  let response: Response;
  try {
    response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${c.DEEPGRAM_API_KEY}`, "Content-Type": contentType || "application/octet-stream" },
      body: Buffer.from(audio),
      signal,
    });
  } catch (error) {
    throw new TranscriptionError("Couldn't reach the speech service. Try again.", 502, { cause: error });
  }

  const body = (await response.json().catch(() => null)) as {
    results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
    metadata?: { duration?: number };
    err_msg?: string;
  } | null;

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionError("The speech service rejected its API key. Check DEEPGRAM_API_KEY.", 502);
    }
    if (response.status === 402) throw new TranscriptionError("The speech service account is out of credit.", 502);
    if (response.status === 429) throw new TranscriptionError("The speech service is busy. Wait a moment and try again.", 429);
    if (response.status === 400) throw new TranscriptionError("That recording couldn't be read. Try recording again.", 422);
    throw new TranscriptionError(`The speech service failed (${response.status}). Try again.`, 502, { cause: body?.err_msg });
  }

  const best = body?.results?.channels?.[0]?.alternatives?.[0];
  return {
    text: (best?.transcript ?? "").trim(),
    confidence: best?.confidence ?? 0,
    seconds: body?.metadata?.duration ?? 0,
  };
}
