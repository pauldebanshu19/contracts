import { MAX_DOCS_PER_CHAT, config, llmConfigured, researchByDefault, voiceConfigured } from "@/lib/config";
import { ready } from "@/lib/http";

/** Limits and status the browser needs before it can validate an upload or ask a question. */
export async function GET() {
  await ready();
  const c = config();
  return Response.json({
    maxUploadMb: c.MAX_UPLOAD_MB,
    maxDocsPerChat: MAX_DOCS_PER_CHAT,
    llmConfigured: llmConfigured(),
    model: c.LLM_MODEL || null,
    voiceConfigured: voiceConfigured(),
    researchDefault: researchByDefault(),
  });
}
