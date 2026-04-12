import type { Request, Response } from "express";
import fetch from "node-fetch";

function falKey(): string {
<<<<<<< HEAD
  return String(process.env.FAL_API_KEY || process.env.FAL_KEY || "").trim();
=======
  return String(process.env.FAL_API_KEY || "").trim();
>>>>>>> 1a3378e1c2243036e72c2771b88085e365419b94
}

function requireFalKey(res: Response): string | null {
  const key = falKey();
  if (!key) {
<<<<<<< HEAD
    res.status(500).json({ error: "FAL_KEY or FAL_API_KEY is not set" });
=======
    res.status(500).json({ error: "FAL_API_KEY is not set" });
>>>>>>> 1a3378e1c2243036e72c2771b88085e365419b94
    return null;
  }
  return key;
}

function toNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** POST /images/fal/flux-lora-fast-training */
export async function falFluxLoraFastTraining(req: Request, res: Response) {
  try {
    const key = requireFalKey(res);
    if (!key) return;

    const images_data_url = String(req.body?.images_data_url ?? "").trim();
    if (!images_data_url) {
      return res.status(400).json({ error: "images_data_url is required (URL to zip)" });
    }

    const trigger_wordRaw = String(req.body?.trigger_word ?? "").trim();
    const trigger_word = trigger_wordRaw.length ? trigger_wordRaw : undefined;
    const steps = toNumber(req.body?.steps);
    const is_style =
      typeof req.body?.is_style === "boolean"
        ? req.body.is_style
        : String(req.body?.is_style ?? "").toLowerCase() === "true"
        ? true
        : undefined;
    const create_masks =
      typeof req.body?.create_masks === "boolean"
        ? req.body.create_masks
        : String(req.body?.create_masks ?? "").toLowerCase() === "false"
        ? false
        : undefined;

    const payload: any = {
      images_data_url,
      ...(trigger_word ? { trigger_word } : {}),
      ...(typeof steps === "number" ? { steps: Math.max(1, Math.min(10000, Math.round(steps))) } : {}),
      ...(typeof is_style === "boolean" ? { is_style } : {}),
      ...(typeof create_masks === "boolean" ? { create_masks } : {}),
    };

    const r = await fetch("https://fal.run/fal-ai/flux-lora-fast-training", {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await r.json().catch(() => null)) as any;
    if (!r.ok) {
      return res.status(502).json({
        error: "fal_train_failed",
        status: r.status,
        details: data ?? null,
      });
    }

    const loraUrl = data?.diffusers_lora_file?.url;
    const configUrl = data?.config_file?.url;
    return res.json({
      ok: true,
      diffusers_lora_file_url: loraUrl ?? null,
      config_file_url: configUrl ?? null,
      raw: data,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "fal_train_failed" });
  }
}

/** POST /images/fal/flux-lora */
export async function falFluxLora(req: Request, res: Response) {
  try {
    const key = requireFalKey(res);
    if (!key) return;

    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const seed = toNumber(req.body?.seed);
    const num_inference_steps = toNumber(req.body?.num_inference_steps);
    const guidance_scale = toNumber(req.body?.guidance_scale);
    const output_formatRaw = String(req.body?.output_format ?? "").trim().toLowerCase();
    const output_format =
      output_formatRaw === "png" ? "png" : output_formatRaw === "jpeg" ? "jpeg" : undefined;
    const sync_mode =
      typeof req.body?.sync_mode === "boolean"
        ? req.body.sync_mode
        : String(req.body?.sync_mode ?? "").toLowerCase() === "true"
        ? true
        : true; // default to data URI for app rendering

    const loraUrlRaw = String(req.body?.lora_url ?? req.body?.loraUrl ?? "").trim();
    const loraScale = toNumber(req.body?.lora_scale ?? req.body?.loraScale);
    const loras =
      loraUrlRaw.length > 0
        ? [
            {
              path: loraUrlRaw,
              scale: typeof loraScale === "number" ? loraScale : 1.0,
            },
          ]
        : Array.isArray(req.body?.loras)
        ? req.body.loras
        : undefined;

    const payload: any = {
      prompt,
      sync_mode,
      ...(typeof seed === "number" ? { seed: Math.max(0, Math.floor(seed)) } : {}),
      ...(typeof num_inference_steps === "number"
        ? { num_inference_steps: Math.max(1, Math.min(50, Math.round(num_inference_steps))) }
        : {}),
      ...(typeof guidance_scale === "number"
        ? { guidance_scale: Math.max(0, Math.min(35, guidance_scale)) }
        : {}),
      ...(output_format ? { output_format } : {}),
      ...(loras ? { loras } : {}),
    };

    const r = await fetch("https://fal.run/fal-ai/flux-lora", {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await r.json().catch(() => null)) as any;
    if (!r.ok) {
      return res.status(502).json({
        error: "fal_generate_failed",
        status: r.status,
        details: data ?? null,
      });
    }

    const first = Array.isArray(data?.images) ? data.images[0] : null;
    const url = first?.url;
    return res.json({
      ok: true,
      image: url ?? null,
      seed: data?.seed ?? null,
      raw: data,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "fal_generate_failed" });
  }
}

