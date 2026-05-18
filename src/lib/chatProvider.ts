/**
 * Unified chat-completion dispatcher.
 *
 * Picks between local Unsloth Studio (`xevo`) and OpenAI (`openai`) based on
 * `XEVO_TEXT_PROVIDER`. The response shape is OpenAI-compatible regardless of
 * provider so existing call sites can keep using `choices[0].message.content`.
 */

import {
  xevoChatCompletion,
  type ChatCompletionRequest,
  type OpenAICompatResponse,
} from "./xevoLlm";

export type ChatProvider = "xevo" | "openai";

export function pickChatProvider(override?: ChatProvider | null): ChatProvider {
  if (override === "xevo" || override === "openai") return override;
  const env = String(process.env.XEVO_TEXT_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (env === "xevo") return "xevo";
  return "openai";
}

async function openaiChatCompletion(
  req: ChatCompletionRequest
): Promise<OpenAICompatResponse> {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("[chatProvider] OPENAI_API_KEY missing for provider=openai");
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.response_format) body.response_format = req.response_format;
  // gpt-5-mini and similar reasoning models only support the default temperature; only
  // pass it for non-reasoning models. Caller can omit `temperature` to be safe.
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.max_tokens === "number") body.max_tokens = req.max_tokens;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: OpenAICompatResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as OpenAICompatResponse) : {};
  } catch {
    throw new Error(
      `[chatProvider] OpenAI non-JSON response (${res.status}): ${text.slice(0, 200)}`
    );
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || text.slice(0, 200);
    throw new Error(`[chatProvider] OpenAI HTTP ${res.status}: ${msg}`);
  }
  return parsed;
}

/**
 * Run a chat completion through the configured provider.
 *
 * `provider` overrides the env-based selection. Useful when a specific call site
 * wants to pin to OpenAI temporarily (e.g. the main analysis stays on OpenAI while
 * smaller helpers move to local Unsloth first).
 */
export async function runChat(
  req: ChatCompletionRequest,
  options?: {
    provider?: ChatProvider | null;
    signal?: AbortSignal;
    timeoutMs?: number;
    logLabel?: string;
  }
): Promise<OpenAICompatResponse> {
  const provider = pickChatProvider(options?.provider ?? null);
  if (provider === "xevo") {
    return xevoChatCompletion(req, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      logLabel: options?.logLabel,
    });
  }
  return openaiChatCompletion(req);
}

/** Convenience — pull `choices[0].message.content` from a response, returning `null` if missing. */
export function chatContent(res: OpenAICompatResponse): string | null {
  const c = res?.choices?.[0]?.message?.content;
  return typeof c === "string" && c.length > 0 ? c : null;
}
