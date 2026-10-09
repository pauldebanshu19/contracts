import { z } from "zod";


const number = (fallback: number, min = 1) =>
  z.preprocess((v) => (v === undefined || v === "" ? fallback : Number(v)), z.number().int().min(min));

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://contracts:contracts@localhost:5433/contracts"),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  LLM_MODEL: z.string().default(""),
  /** Model for full-scan batches. Defaults to LLM_MODEL; a smaller model with its own rate limit keeps answers flowing during a scan. */
  LLM_SCAN_MODEL: z.string().default(""),
  /** For reasoning models such as gpt-oss: "low" keeps answers fast and cheap. Sent only when set. */
  LLM_REASONING_EFFORT: z.enum(["", "low", "medium", "high"]).default(""),
  /** The provider's tokens-per-minute limit (Groq's free tier: 8000). 0 means no limit. */
  LLM_TPM: number(0, 0),
  /** Largest prompt to send in one request. 0 derives it from LLM_TPM. */
  LLM_MAX_REQUEST_TOKENS: number(0, 0),
  EMBEDDING_MODEL: z.string().default(""),
  /** Speech-to-text for voice questions. Voice input is hidden when unset. */
  DEEPGRAM_API_KEY: z.string().default(""),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR: number(120),
  MAX_UPLOAD_MB: number(25),
  /** A public URL with no login needs a ceiling on what it stores. */
  MAX_DOCUMENTS: number(50),
  AGENT_MAX_ROUNDS: number(8),
  AGENT_MAX_CALLS_PER_ROUND: number(4),
  /** Per-question budget for everything sent to and received from the model. */
  QUESTION_TOKEN_BUDGET: number(120_000),
  SCAN_CONCURRENCY: number(4),
  SCAN_BATCH_TOKENS: number(12_000),
  RATE_LIMIT_UPLOADS_PER_HOUR: number(30),
  RATE_LIMIT_QUESTIONS_PER_HOUR: number(120),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  // In development Next reloads .env without a restart, so it is read fresh each time there.
  if (process.env.NODE_ENV !== "production") return schema.parse(process.env);
  cached ??= schema.parse(process.env);
  return cached;
}

export function llmConfigured(): boolean {
  const c = config();
  return Boolean(c.LLM_API_KEY && c.LLM_MODEL);
}

export function voiceConfigured(): boolean {
  return Boolean(config().DEEPGRAM_API_KEY);
}

/**
 * The largest prompt, in tokens, that one model request may carry. Some
 * providers refuse any request bigger than their per-minute limit, so with a
 * limit set this stays a margin below it. Unlimited otherwise.
 */
export function promptTokenBudget(): number {
  const c = config();
  if (c.LLM_MAX_REQUEST_TOKENS) return c.LLM_MAX_REQUEST_TOKENS;
  if (c.LLM_TPM) return Math.floor(c.LLM_TPM * 0.85);
  return Number.POSITIVE_INFINITY;
}

/**
 * Research mode re-sends the whole conversation every round, so under a tight
 * per-minute limit it is slow. It stays available, but is not the default.
 */
export function researchByDefault(): boolean {
  const tpm = config().LLM_TPM;
  return tpm === 0 || tpm >= 30_000;
}

export const MAX_DOCS_PER_CHAT = 5;
