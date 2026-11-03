/**
 * Load XEVO_LLM_MODEL into local Unsloth Studio so Railway analyze can call it.
 * Usage: node scripts/load-unsloth-model.mjs
 */
import "dotenv/config";
import { Agent, fetch as undiciFetch } from "undici";

const key = String(process.env.XEVO_LLM_API_KEY || "").trim();
const model = String(process.env.XEVO_LLM_MODEL || "unsloth/Qwen3.5-4B-GGUF").trim();
const envBase = String(process.env.XEVO_LLM_BASE_URL || "").trim().replace(/\/+$/, "");
const studioRoot = (envBase.endsWith("/v1") ? envBase.slice(0, -3) : envBase).replace(/\/+$/, "") || "http://127.0.0.1:8888";
const bases = [...new Set(["http://127.0.0.1:8888", studioRoot])];

const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "1",
};
const agent = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  connectTimeout: 30_000,
});

async function j(url, init = {}) {
  const r = await undiciFetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    dispatcher: agent,
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: r.ok, status: r.status, body };
}

async function pickBase() {
  for (const b of bases) {
    try {
      const st = await j(`${b}/api/inference/status`);
      if (st.status !== 0) return { base: b, status: st };
    } catch (e) {
      console.warn("unreachable", b, e?.message || e);
    }
  }
  throw new Error("No Unsloth Studio reachable");
}

function isLoaded(statusBody, modelsBody) {
  if (statusBody?.loaded === true) return true;
  if (typeof statusBody?.active_model === "string" && statusBody.active_model.trim()) return true;
  if (Array.isArray(modelsBody?.data)) {
    return modelsBody.data.some((m) => m?.loaded === true || m?.status?.value === "loaded");
  }
  return false;
}

const { base, status: st0 } = await pickBase();
console.log("using", base, "model", model);
console.log("status", st0.status, JSON.stringify(st0.body).slice(0, 600));

const models0 = await j(`${base}/v1/models`);
console.log("v1/models", models0.status, JSON.stringify(models0.body).slice(0, 600));

if (isLoaded(st0.body, models0.body)) {
  console.log("model already loaded");
} else {
  const validate = await j(`${base}/api/inference/validate`, {
    method: "POST",
    body: JSON.stringify({ model_path: model, gguf_variant: "UD-Q4_K_XL" }),
  });
  console.log("validate", validate.status, JSON.stringify(validate.body).slice(0, 800));

  console.log("POST /v1/load …");
  const load = await j(`${base}/v1/load`, {
    method: "POST",
    body: JSON.stringify({
      model_path: model,
      gguf_variant: "UD-Q4_K_XL",
      max_seq_length: 0,
      force_cancel_active: true,
    }),
  });
  console.log("load", load.status, JSON.stringify(load.body).slice(0, 1200));
  if (!load.ok && load.status !== 409) {
    process.exit(1);
  }

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await j(`${base}/v1/load-progress`);
    const b = p.body || {};
    const label = b.status || b.state || b.phase || b.progress || JSON.stringify(b).slice(0, 180);
    console.log("progress", i, p.status, label);
    if (["ready", "loaded", "complete", "done"].includes(String(b.status || b.state || "").toLowerCase())) {
      break;
    }
    if (String(b.status || b.state || "").toLowerCase() === "error" || b.error) {
      console.error(b);
      process.exit(1);
    }
    const st = await j(`${base}/api/inference/status`);
    if (isLoaded(st.body, null)) {
      console.log("status reports loaded");
      break;
    }
  }
}

const chat = await j(`${base}/v1/chat/completions`, {
  method: "POST",
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 16,
    temperature: 0,
  }),
});
console.log("chat", chat.status, JSON.stringify(chat.body).slice(0, 500));
if (!chat.ok) process.exit(1);
console.log("ok");
