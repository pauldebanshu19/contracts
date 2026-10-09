import { MAX_DOCS_PER_CHAT, config, llmConfigured, maxUploadMb, researchByDefault, voiceConfigured } from "@/lib/config";
import { ready } from "@/lib/http";

/** Limits and status the browser needs before it can validate an upload or ask a question. */
export async function GET() {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const c = config();
  return Response.json({
    maxUploadMb: maxUploadMb(),
    maxDocsPerChat: MAX_DOCS_PER_CHAT,
    llmConfigured: llmConfigured(),
    model: c.LLM_MODEL || null,
    voiceConfigured: voiceConfigured(),
    researchDefault: researchByDefault(),
  });
}
