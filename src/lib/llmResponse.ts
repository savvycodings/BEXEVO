/**
 * Helpers for local Unsloth / OpenAI chat completion bodies.
 *
 * Unsloth's transformers backend yields `Error: <exception>` as normal assistant
 * content when `model.generate()` fails (CUDA OOM, etc.) — HTTP stays 200.
 */

/** True when Studio returned a generation failure as message content. */
export function isStudioGenerationErrorContent(content: string): boolean {
  const t = content.trim();
  return /^Error:\s/.test(t) || /^RuntimeError:\s/.test(t) || /^CUDA\b/i.test(t);
}

/** Strip optional markdown fences before JSON.parse. */
export function stripJsonCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  return m ? m[1].trim() : t;
}

/** Remove Qwen / Studio thinking blocks so JSON extraction can find the answer object. */
export function stripThinkingBlocks(text: string): string {
  let t = text;
  const thinkOpen = "<" + "think>";
  const thinkClose = "</" + "think>";
  t = t.replace(new RegExp(thinkOpen + "[\\s\\S]*?" + thinkClose, "gi"), "");
  t = t.replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, "");
  if (/^thinking\s+process:/i.test(t)) {
    const jsonStart = t.indexOf("{");
    if (jsonStart > 0) t = t.slice(jsonStart);
  }
  return t.trim();
}

/**
 * Pull the first top-level `{ ... }` object from model text (after thinking preamble).
 */
function extractJsonObjectFromIndex(text: string, start: number): string | null {
  if (start < 0 || text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJsonObjectSubstring(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  return extractJsonObjectFromIndex(text, start);
}

/** Parse LLM text that may be raw JSON, fenced ```json, or wrapped in brief prose. */
export function parseFlexibleJsonFromLlmContent(content: string): unknown {
  if (isStudioGenerationErrorContent(content)) {
    throw new Error(
      `LLM generation error in content: ${content.trim().slice(0, 200)}`
    );
  }
  const stripped = stripJsonCodeFence(content.trim());
  try {
    return JSON.parse(stripped);
  } catch {
    const obj = extractJsonObjectSubstring(stripThinkingBlocks(stripped));
    if (obj) return JSON.parse(obj);
    const arrStart = stripped.indexOf("[");
    if (arrStart >= 0) {
      const arr = extractJsonObjectFromIndex(stripped, arrStart);
      if (arr) return JSON.parse(arr);
    }
    throw new Error(
      `Could not parse JSON from LLM content: ${stripped.slice(0, 200)}`
    );
  }
}

/** Parse a JSON array (or `{ "deltas": [...] }`) from correction / helper LLM calls. */
export function parseJsonArrayFromLlmContent(content: string): unknown[] {
  const parsed = parseFlexibleJsonFromLlmContent(content);
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { deltas?: unknown[] }).deltas)
  ) {
    return (parsed as { deltas: unknown[] }).deltas;
  }
  return [];
}

function scoreTechniqueAnalysisJson(obj: unknown): number {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
  const o = obj as Record<string, unknown>;
  let score = 0;
  if ("is_padel" in o) score += 20;
  if (typeof o.score === "number") score += 15;
  if (o.en && typeof o.en === "object") score += 10;
  if (typeof o.rating === "string") score += 5;
  if (o.shot_context) score += 5;
  return score;
}

/** Try every `{`…`}` span; return the best candidate that looks like technique analyze JSON. */
export function extractBestTechniqueJsonText(content: string): string | null {
  const cleaned = stripThinkingBlocks(content.trim());
  let best: { text: string; score: number } | null = null;

  for (let pos = 0; pos < cleaned.length; pos++) {
    if (cleaned[pos] !== "{") continue;
    const candidate = extractJsonObjectFromIndex(cleaned, pos);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const score = scoreTechniqueAnalysisJson(parsed);
      if (score > 0 && (!best || score > best.score || candidate.length > best.text.length)) {
        best = { text: candidate, score };
      }
    } catch {
      /* try next span */
    }
    pos = cleaned.indexOf("{", pos + 1);
    if (pos === -1) break;
  }

  return best?.text ?? null;
}

/** True if the assistant text contains a parseable top-level JSON object. */
export function llmContentHasJsonObject(content: string): boolean {
  const t = content.trim();
  if (t.startsWith("{")) {
    try {
      JSON.parse(t);
      return true;
    } catch {
      /* fall through */
    }
  }
  if (extractBestTechniqueJsonText(content)) return true;
  return extractJsonObjectSubstring(stripThinkingBlocks(t)) !== null;
}

/** Normalize assistant content to a JSON string suitable for `JSON.parse`. */
export function normalizeJsonPayloadFromLlmContent(content: string): {
  jsonText: string;
  strategy: "direct" | "fenced" | "extracted";
} {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { jsonText: trimmed, strategy: "direct" };
  }

  const fenced = stripJsonCodeFence(trimmed);
  if (fenced !== trimmed && (fenced.startsWith("{") || fenced.startsWith("["))) {
    return { jsonText: fenced, strategy: "fenced" };
  }

  const withoutThinking = stripThinkingBlocks(trimmed);
  const extracted =
    extractBestTechniqueJsonText(trimmed) ??
    extractJsonObjectSubstring(withoutThinking) ??
    extractJsonObjectSubstring(trimmed);
  if (extracted) {
    return { jsonText: extracted, strategy: "extracted" };
  }

  return { jsonText: trimmed, strategy: "direct" };
}

export function parseJsonFromLlmContent(
  content: string,
  context?: { label?: string }
): unknown {
  if (isStudioGenerationErrorContent(content)) {
    const preview = content.trim().slice(0, 400);
    console.error("[llmResponse] Unsloth generation error in content", {
      label: context?.label,
      preview,
    });
    throw new Error(
      `Local LLM generation failed (Unsloth): ${preview.slice(0, 200)}. ` +
        "Check the Unsloth terminal for the full CUDA/stack trace; try fewer pose frames (XEVO_ANALYZE_MAX_POSE_FRAMES) or a GGUF via unsloth run."
    );
  }

  const { jsonText, strategy } = normalizeJsonPayloadFromLlmContent(content);
  if (!llmContentHasJsonObject(content)) {
    console.error("[llmResponse] model returned prose with no JSON object", {
      label: context?.label,
      contentChars: content.length,
      contentPreview: content.trim().slice(0, 300),
    });
    throw new Error(
      "Local LLM returned planning text but no JSON object (often max_tokens too low or model ignored json_object). " +
        "Raise XEVO_LLM_MAX_TOKENS, ensure enable_thinking=false, and retry analyze."
    );
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (strategy === "extracted") {
      console.log("[llmResponse] parsed JSON after stripping thinking / extracting object", {
        label: context?.label,
        strategy,
        contentChars: content.length,
        jsonChars: jsonText.length,
      });
    }
    return parsed;
  } catch (e) {
    console.error("[llmResponse] JSON.parse failed", {
      label: context?.label,
      strategy,
      contentPreview: content.trim().slice(0, 400),
      jsonPreview: jsonText.slice(0, 400),
      contentChars: content.length,
    });
    throw e;
  }
}
