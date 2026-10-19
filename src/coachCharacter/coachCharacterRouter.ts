/**
 * Coach character chat: text replies, spoken replies and dictation for the
 * score-ring avatar popup on the technique results screen.
 *
 * - POST /context     { message, analysisId?, locale? } -> CoachContext (facts shown as the thinking trace)
 * - POST /chat        { messages, analysisId?, locale? } -> { reply }  (Qwen via xevoChatCompletion)
 * - POST /speech      { text, locale? }         -> { audioBase64, mimeType }  (voice Studio)
 * - POST /transcribe  { audioBase64, language? } -> { text }       (main Studio STT sidecar)
 *
 * Env:
 * - XEVO_TTS_BASE_URL     EN voice Studio OpenAI base (default http://127.0.0.1:8889/v1)
 * - XEVO_TTS_ES_BASE_URL  ES Chatterbox OpenAI base (default http://127.0.0.1:8890/v1)
 * - XEVO_TTS_API_KEY      voice Studio key (falls back to XEVO_LLM_API_KEY; unused by Chatterbox)
 * - XEVO_TTS_MODEL        EN Orpheus id (default vinhnx90/VT-Orpheus-3B-TTS-Ceylia-Q4KM-GGUFF)
 * - XEVO_TTS_VOICE        EN Orpheus voice (default ceylia)
 * - XEVO_TTS_ES_MODEL     ES Chatterbox id (default ResembleAI/chatterbox)
 * - XEVO_TTS_ES_VOICE     ES voice label (default chatterbox-es)
 *
 * Mounted ahead of the global 100kb JSON parser because dictation audio is larger.
 */
import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { Agent, fetch as undiciFetch } from "undici";
import { auth } from "../auth";
import { buildCoachContext, contextPrompt, type CoachContext, type CoachLocale } from "./coachContext";
import { readChatContent, xevoChatCompletion, type ChatMessage } from "../lib/xevoLlm";
import { withNgrokHeaders } from "../lib/ngrokFetch";

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 800;
const MAX_SPEECH_CHARS = 400;
const MAX_AUDIO_B64_CHARS = 12 * 1024 * 1024;
const ORPHEUS_TAGS = new Set([
  "laugh",
  "chuckle",
  "sigh",
  "cough",
  "sniffle",
  "groan",
  "yawn",
  "gasp",
  "giggle",
]);

function trimBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function ttsApiKey(): string {
  return (
    String(process.env.XEVO_TTS_API_KEY ?? "").trim() ||
    String(process.env.XEVO_LLM_API_KEY ?? "").trim()
  );
}

type TtsTarget = {
  baseUrl: string;
  model: string;
  voice: string;
  variant: string;
  locale: CoachLocale;
};

/** English Ceylia on :8889 (Orpheus); Spanish Chatterbox on :8890. */
function ttsTarget(locale: CoachLocale): TtsTarget {
  if (locale === "es") {
    return {
      locale,
      baseUrl: trimBase(
        String(process.env.XEVO_TTS_ES_BASE_URL ?? "").trim() || "http://127.0.0.1:8890/v1"
      ),
      model: String(process.env.XEVO_TTS_ES_MODEL ?? "").trim() || "ResembleAI/chatterbox",
      voice: String(process.env.XEVO_TTS_ES_VOICE ?? "").trim() || "chatterbox-es",
      variant: "",
    };
  }
  return {
    locale,
    baseUrl: trimBase(String(process.env.XEVO_TTS_BASE_URL ?? "").trim() || "http://127.0.0.1:8889/v1"),
    model:
      String(process.env.XEVO_TTS_MODEL ?? "").trim() ||
      "vinhnx90/VT-Orpheus-3B-TTS-Ceylia-Q4KM-GGUFF",
    voice: String(process.env.XEVO_TTS_VOICE ?? "").trim() || "ceylia",
    variant: String(process.env.XEVO_TTS_VARIANT ?? "").trim() || "Q4_K_M",
  };
}

/** Studio root (no /v1) for the main instance, used by the STT sidecar route. */
function mainStudioRoot(): string {
  const raw = trimBase(String(process.env.XEVO_LLM_BASE_URL ?? "").trim() || "http://127.0.0.1:8888/v1");
  return raw.replace(/\/v1$/, "");
}

async function resolveUserId(req: express.Request): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const text = content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (text) out.push({ role, content: text });
  }
  return out.slice(-MAX_HISTORY);
}

function readLocale(raw: unknown): CoachLocale {
  return typeof raw === "string" && raw.toLowerCase().startsWith("es") ? "es" : "en";
}

function personaPrompt(summary: string | null): string {
  const lines = [
    "You are Joy, the cheerful padel coach character inside the Xevo app.",
    "You talk with a player who just got an AI analysis of their padel shot.",
    "Reply in 1 to 3 short spoken sentences. Be warm, encouraging and concrete.",
    "No markdown, no lists, no emojis. Plain conversational text only.",
    "You may occasionally add one Orpheus sound tag like <laugh> or <giggle> where natural.",
    "Answer in the same language the player writes in.",
    "If asked something unrelated to padel or fitness, steer back to their game kindly.",
  ];
  if (summary) {
    lines.push("", "Facts you checked before answering (use them, do not invent numbers):", summary);
  }
  return lines.join("\n");
}

/** Normalizes sound tags (the model sometimes drops the closing `>`) and removes unknown ones. */
function normalizeTags(raw: string): string {
  return raw.replace(/<\/?\s*([a-zA-Z]+)\s*\/?>?/g, (_m, tag: string) => {
    const t = tag.toLowerCase();
    return ORPHEUS_TAGS.has(t) ? `<${t}> ` : "";
  });
}

function cleanReply(raw: string): string {
  return normalizeTags(raw.replace(/<think>[\s\S]*?<\/think>/gi, ""))
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keep plain speech plus supported Orpheus tags; drop anything else that looks like markup. */
function speechText(raw: string): string {
  const kept = raw.replace(/<\/?([a-z]+)[^>]*>/gi, (m, tag: string) =>
    ORPHEUS_TAGS.has(tag.toLowerCase()) && !m.startsWith("</") ? `<${tag.toLowerCase()}>` : " "
  );
  const plain = kept
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`~|[\]{}]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= MAX_SPEECH_CHARS) return plain;
  const cut = plain.slice(0, MAX_SPEECH_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > 80 ? cut.slice(0, end + 1) : cut).trim();
}

router.post("/chat", async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const history = sanitizeHistory(req.body?.messages);
  if (!history.length || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "messages must end with a user message" });
  }
  const analysisId = typeof req.body?.analysisId === "string" ? req.body.analysisId.trim() : "";
  const locale = readLocale(req.body?.locale);
  try {
    const ctx = await buildCoachContext(userId, {
      analysisId,
      message: history[history.length - 1].content,
      locale,
    }).catch(() => null);
    const summary = ctx ? contextPrompt(ctx) : null;
    const completion = await xevoChatCompletion(
      {
        model: "unsloth/Qwen3.5-4B-GGUF",
        messages: [{ role: "system", content: personaPrompt(summary) }, ...history],
        temperature: 0.7,
        max_tokens: 220,
      },
      { timeoutMs: 60_000, logLabel: "coach-character-chat" }
    );
    const reply = cleanReply(readChatContent(completion));
    if (!reply) return res.status(502).json({ error: "Empty reply" });
    return res.json({ reply });
  } catch (e) {
    console.error("[CoachCharacter] chat error", e instanceof Error ? e.message : e);
    return res.status(502).json({ error: "Coach is unavailable right now" });
  }
});

router.post("/context", async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, MAX_MESSAGE_CHARS) : "";
  const analysisId = typeof req.body?.analysisId === "string" ? req.body.analysisId : "";
  try {
    const ctx = await buildCoachContext(userId, { analysisId, message, locale: readLocale(req.body?.locale) });
    return res.json(ctx);
  } catch (e) {
    console.error("[CoachCharacter] context error", e instanceof Error ? e.message : e);
    return res.json({ kind: "none", analysis: null, day: null } satisfies CoachContext);
  }
});

router.post("/speech", async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const input = speechText(typeof req.body?.text === "string" ? req.body.text : "");
  if (!input) return res.status(400).json({ error: "text is required" });
  const locale = readLocale(req.body?.locale);
  const target = ttsTarget(locale);

  const url = `${target.baseUrl}/audio/speech`;
  const key = ttsApiKey();
  try {
    const r = await undiciFetch(url, {
      method: "POST",
      headers: withNgrokHeaders(url, {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      }),
      body: JSON.stringify({
        input,
        model: target.model,
        voice: target.voice,
        response_format: "wav",
      }),
      dispatcher: new Agent({ headersTimeout: 90_000, bodyTimeout: 90_000, connectTimeout: 5_000 }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      console.warn("[CoachCharacter] speech HTTP error", {
        status: r.status,
        detail,
        locale: target.locale,
        model: target.model,
        voice: target.voice,
      });
      return res.status(503).json({ error: "Voice is offline" });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const mimeType = r.headers.get("content-type")?.split(";")[0]?.trim() || "audio/wav";
    return res.json({ audioBase64: buf.toString("base64"), mimeType, locale: target.locale, voice: target.voice });
  } catch (e) {
    console.warn("[CoachCharacter] speech unavailable", {
      locale: target.locale,
      model: target.model,
      err: e instanceof Error ? e.message : e,
    });
    return res.status(503).json({ error: "Voice is offline" });
  }
});

router.post("/transcribe", async (req, res) => {
  const userId = await resolveUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const audio = typeof req.body?.audioBase64 === "string" ? req.body.audioBase64.trim() : "";
  if (!audio) return res.status(400).json({ error: "audioBase64 is required" });
  if (audio.length > MAX_AUDIO_B64_CHARS) return res.status(413).json({ error: "Audio is too large" });
  const language =
    typeof req.body?.language === "string" && req.body.language.trim()
      ? req.body.language.trim()
      : undefined;

  const url = `${mainStudioRoot()}/api/inference/audio/transcribe`;
  const key = String(process.env.XEVO_LLM_API_KEY ?? "").trim();
  try {
    const r = await undiciFetch(url, {
      method: "POST",
      headers: withNgrokHeaders(url, {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      }),
      body: JSON.stringify({ audio, language, fast: true }),
      dispatcher: new Agent({ headersTimeout: 120_000, bodyTimeout: 120_000, connectTimeout: 10_000 }),
    });
    const raw = await r.text();
    if (!r.ok) {
      console.warn("[CoachCharacter] transcribe HTTP error", { status: r.status, detail: raw.slice(0, 200) });
      return res.status(502).json({ error: "Could not transcribe audio" });
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }
    const text = typeof parsed.text === "string" ? parsed.text : typeof parsed.transcript === "string" ? parsed.transcript : "";
    return res.json({ text: text.trim() });
  } catch (e) {
    console.warn("[CoachCharacter] transcribe unavailable", e instanceof Error ? e.message : e);
    return res.status(502).json({ error: "Could not transcribe audio" });
  }
});

export default router;
