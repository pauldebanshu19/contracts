import { config, voiceConfigured } from "@/lib/config";
import { jsonError, rateLimited, ready } from "@/lib/http";
import { TranscriptionError, transcribe } from "@/lib/voice/deepgram";

/** About five minutes of compressed speech: far more than a question needs. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|x-m4a)(;.*)?$/i;

/** Turn a recorded question into text. The browser sends the raw recording; the reply is the transcript. */
export async function POST(request: Request) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  if (!voiceConfigured()) return jsonError(503, "Voice input isn't configured on the server.");
  const limited = rateLimited(request, "transcribe", config().RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR);
  if (limited) return limited;

  const type = request.headers.get("content-type") ?? "";
  if (!AUDIO_TYPE.test(type)) return jsonError(415, "Send the recording as audio.");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return jsonError(413, "That recording is too long. Keep questions under a few minutes.");

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) return jsonError(413, "That recording is too long. Keep questions under a few minutes.");
  if (audio.length < 200) return jsonError(422, "The recording was empty. Try again.");

  try {
    const transcript = await transcribe(audio, type, request.signal);
    if (!transcript.text) return jsonError(422, "No speech was recognised. Try again, a little closer to the microphone.");
    return Response.json(transcript);
  } catch (error) {
    if (error instanceof TranscriptionError) return jsonError(error.status, error.message);
    console.error("[transcribe]", error);
    return jsonError(500, "Transcription failed. Try again.");
  }
}
