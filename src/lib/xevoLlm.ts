/**
 * Local Unsloth Studio LLM client.
 *
 * Studio (`finetune/unsloth/studio/backend`) exposes OpenAI-compatible routes at
 * `${XEVO_LLM_BASE_URL}/chat/completions`, backed by a `llama-server` subprocess
 * running a GGUF model. Default base URL is `http://127.0.0.1:8888/v1`.
 *
 * HTTP timeout defaults to `XEVO_LLM_TIMEOUT_MS` (ms) or 120_000.
 * Uses undici with raised `headersTimeout` — Node's default fetch only waits ~300s
 * for response headers, which technique analyze blows past on a 140k-char prompt.
 *
 * `XEVO_LLM_MODEL` must match the model id Studio has loaded (e.g. `unsloth/Qwen3.5-4B`),
 * not an old GGUF alias like `qwen3-8b-instruct-q4_k_m`.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { isStudioGenerationErrorContent } from "./llmResponse";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  /** Caller's preferred model id. With Unsloth, this is overridden by `XEVO_LLM_MODEL`. */
  model: string;
  messages: ChatMessage[];
  response_format?: { type: "json_object" } | { type: "text" };
  temperature?: number;
  max_tokens?: number;
}

export interface OpenAICompatChoice {
  index?: number;
  message?: { role: ChatRole; content: string };
  finish_reason?: string;
}

export interface OpenAICompatResponse {
  id?: string;
  model?: string;
  choices?: OpenAICompatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

function trimBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function xevoBaseUrl(): string {
  const raw = String(process.env.XEVO_LLM_BASE_URL ?? "").trim();
  return trimBase(raw || "http://127.0.0.1:8888/v1");
}

function xevoModel(fallback: string): string {
  const m = String(process.env.XEVO_LLM_MODEL ?? "").trim();
  return m || fallback;
}

function xevoApiKey(): string {
  return String(process.env.XEVO_LLM_API_KEY ?? "").trim();
}

function xevoTimeoutMs(override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  const envTimeout = Number(String(process.env.XEVO_LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000;
}

/** undici defaults headersTimeout ≈ 300s; long local generations need this aligned with XEVO_LLM_TIMEOUT_MS. */
function xevoFetchAgent(timeoutMs: number): Agent {
  const pad = Math.max(timeoutMs, 60_000);
  return new Agent({
    headersTimeout: pad,
    bodyTimeout: pad,
    connectTimeout: 120_000,
  });
}

/** Log once if env model id is not among Studio's loaded /v1/models (best-effort). */
export async function warnIfXevoModelMismatch(): Promise<void> {
  const configured = String(process.env.XEVO_LLM_MODEL ?? "").trim();
  if (!configured) return;
  const base = xevoBaseUrl();
  const key = xevoApiKey();
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const r = await undiciFetch(`${base}/models`, {
      method: "GET",
      headers,
      dispatcher: new Agent({ headersTimeout: 15_000, connectTimeout: 10_000 }),
    });
    if (!r.ok) return;
    const data = (await r.json()) as { data?: Array<{ id?: string }> };
    const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
    if (ids.length === 0) return;
    if (!ids.includes(configured)) {
      console.warn("[xevoLlm] XEVO_LLM_MODEL does not match any model loaded in Unsloth Studio", {
        configured,
        loadedInStudio: ids,
        hint: "Set XEVO_LLM_MODEL to one of loadedInStudio (exact string), then restart the xevo server.",
      });
    }
    const anyGgufLoaded = ids.some((id) => /gguf/i.test(id));
    const configuredLooksGguf = /gguf/i.test(configured);
    if (!anyGgufLoaded && !configuredLooksGguf) {
      console.warn(
        "[xevoLlm] Technique analyze uses response_format json_object — that requires a GGUF model in Studio (llama-server GBNF grammar). " +
          "HF weights like unsloth/Qwen3.5-4B often emit planning prose instead of JSON. " +
          "In Studio Chat, load unsloth/Qwen3.5-4B-GGUF (or Qwen3-4B-Instruct-GGUF), then set XEVO_LLM_MODEL from GET /v1/models.",
        { configured, loadedInStudio: ids }
      );
    }
  } catch {
    /* Studio offline or auth — skip */
  }
}

/**
 * POST a chat completion to the local Unsloth Studio server.
 * Always uses the model configured via `XEVO_LLM_MODEL`, falling back to the
 * caller-provided `model` only when the env var is unset.
 */
function summarizeMessagesForLog(messages: ChatMessage[]): {
  messageCount: number;
  totalChars: number;
  roles: string;
} {
  const roles = messages.map((m) => m.role).join(",");
  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  return { messageCount: messages.length, totalChars, roles };
}

export async function xevoChatCompletion(
  req: ChatCompletionRequest,
  options?: { signal?: AbortSignal; timeoutMs?: number; logLabel?: string }
): Promise<OpenAICompatResponse> {
  const base = xevoBaseUrl();
  const url = `${base}/chat/completions`;
  const model = xevoModel(req.model);
  const label = options?.logLabel ?? "chat";
  const msgSummary = summarizeMessagesForLog(req.messages);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = xevoApiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const enableThinkingEnv = String(
    process.env.XEVO_LLM_ENABLE_THINKING ?? ""
  )
    .trim()
    .toLowerCase();
  const enableThinking =
    enableThinkingEnv === "1" ||
    enableThinkingEnv === "true" ||
    enableThinkingEnv === "yes";

  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    // Technique analyze needs the full JSON body before parse; Unsloth UI chat uses stream:true.
    stream: false,
    // Qwen3.5 defaults to "Thinking Process:" preamble; breaks json_object analyze unless disabled.
    enable_thinking: enableThinking,
    chat_template_kwargs: { enable_thinking: enableThinking },
  };
  if (req.response_format) body.response_format = req.response_format;
  if (typeof req.temperature === "number") {
    body.temperature = req.temperature;
  } else if (req.response_format?.type === "json_object") {
    body.temperature = 0.2;
  }
  if (typeof req.max_tokens === "number") {
    body.max_tokens = req.max_tokens;
  } else if (req.response_format?.type === "json_object") {
    const envMax = Number(String(process.env.XEVO_LLM_MAX_TOKENS ?? "8192").trim());
    body.max_tokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 8192;
  }

  const timeoutMs = xevoTimeoutMs(options?.timeoutMs);
  const agent = xevoFetchAgent(timeoutMs);
  const controller = options?.signal ? undefined : new AbortController();
  const timeout =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  const started = Date.now();
  console.log("[xevoLlm] request start", {
    label,
    url,
    model,
    stream: false,
    timeoutMs,
    undiciHeadersTimeoutMs: timeoutMs,
    ...msgSummary,
    hasApiKey: Boolean(key),
    responseFormat: req.response_format?.type ?? null,
    enableThinking,
    maxTokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
  });

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal ?? controller?.signal,
      dispatcher: agent,
    });
  } catch (e) {
    if (timeout) clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    const causeCode =
      cause && "code" in cause ? String((cause as NodeJS.ErrnoException).code) : "";
    console.error("[xevoLlm] request failed (transport)", {
      label,
      url,
      model,
      elapsedMs: Date.now() - started,
      message: msg,
      causeCode: causeCode || undefined,
      causeMessage: cause?.message,
      hint:
        causeCode === "ECONNREFUSED"
          ? "Unsloth Studio not listening on XEVO_LLM_BASE_URL — is the tab up and model loaded?"
          : causeCode === "UND_ERR_HEADERS_TIMEOUT"
            ? "Node gave up waiting for response headers (~300s default). undici headersTimeout is now tied to XEVO_LLM_TIMEOUT_MS; if this persists, reduce prompt size or raise XEVO_LLM_TIMEOUT_MS."
            : causeCode === "ECONNRESET" || msg.includes("aborted")
              ? "Connection dropped or XEVO_LLM_TIMEOUT_MS fired; local model may still be generating."
              : undefined,
    });
    throw new Error(`[xevoLlm] fetch failed for ${url}: ${msg}`);
  }
  if (timeout) clearTimeout(timeout);

  const text = await res.text();
  const elapsedMs = Date.now() - started;
  let parsed: OpenAICompatResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as OpenAICompatResponse) : {};
  } catch {
    throw new Error(
      `[xevoLlm] non-JSON response (${res.status}) from ${url}: ${text.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    const msg =
      parsed?.error?.message ||
      (typeof parsed === "object" && parsed && "detail" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).detail)
        : "") ||
      text.slice(0, 200);
    console.error("[xevoLlm] request failed (HTTP)", {
      label,
      status: res.status,
      elapsedMs,
      message: msg,
      bodyPreview: text.slice(0, 300),
    });
    throw new Error(`[xevoLlm] HTTP ${res.status}: ${msg}`);
  }

  const assistantContent = parsed?.choices?.[0]?.message?.content;
  if (typeof assistantContent === "string" && isStudioGenerationErrorContent(assistantContent)) {
    console.error("[xevoLlm] Unsloth returned generation error as assistant content", {
      label,
      elapsedMs,
      preview: assistantContent.trim().slice(0, 500),
      hint:
        "Studio was running (~8min) but model.generate() failed (often CUDA OOM on huge prompts). See Unsloth logs: Generation error. Reduce XEVO_ANALYZE_MAX_POSE_FRAMES or load a GGUF with unsloth run.",
    });
    throw new Error(
      `[xevoLlm] Unsloth generation failed: ${assistantContent.trim().slice(0, 250)}`
    );
  }

  console.log("[xevoLlm] request ok", {
    label,
    elapsedMs,
    responseChars: text.length,
    assistantContentChars:
      typeof assistantContent === "string" ? assistantContent.length : 0,
    usage: parsed?.usage,
    finishReason: parsed?.choices?.[0]?.finish_reason,
  });

  return parsed;
}

/**
 * Convenience helper — extract the assistant `content` string, or throw if missing.
 * If `response_format: json_object` was requested and the model returned something
 * that does not parse as JSON, callers should run their own JSON repair logic.
 */
export function readChatContent(res: OpenAICompatResponse): string {
  const c = res?.choices?.[0]?.message?.content;
  if (typeof c !== "string" || c.length === 0) {
    throw new Error(
      `[xevoLlm] empty content in response: ${JSON.stringify(res).slice(0, 300)}`
    );
  }
  return c;
}
