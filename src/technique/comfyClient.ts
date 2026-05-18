import { randomUUID } from "crypto";

export type ComfyUploadedImage = {
  name: string;
  subfolder: string;
  type: string;
};

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/** POST /upload/image — image must appear under ComfyUI `input` for Load Image nodes. */
export async function comfyUploadImage(
  baseUrl: string,
  buffer: Buffer,
  filename: string
): Promise<ComfyUploadedImage> {
  const base = trimBaseUrl(baseUrl);
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(buffer)], { type: "image/png" }),
    filename
  );
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(`${base}/upload/image`, { method: "POST", body: form });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`ComfyUI upload: invalid JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `ComfyUI upload failed ${res.status}: ${(data.detail as string) || text.slice(0, 300)}`
    );
  }
  const name = typeof data.name === "string" ? data.name : "";
  if (!name) throw new Error(`ComfyUI upload: missing name in response: ${text.slice(0, 300)}`);
  return {
    name,
    subfolder: typeof data.subfolder === "string" ? data.subfolder : "",
    type: typeof data.type === "string" ? data.type : "input",
  };
}

export type ComfyQueueResult = { prompt_id: string; number?: number };

export async function comfyQueuePrompt(
  baseUrl: string,
  prompt: Record<string, unknown>,
  clientId?: string
): Promise<ComfyQueueResult> {
  const base = trimBaseUrl(baseUrl);
  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      client_id: clientId || randomUUID(),
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`ComfyUI /prompt: invalid JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const nodeErrors = data.node_errors;
    if (nodeErrors && typeof nodeErrors === "object") {
      console.error(
        "[comfyClient] ComfyUI node_errors:",
        JSON.stringify(nodeErrors, null, 2)
      );
    }
    const err =
      (data.error as { message?: string } | string | undefined) ??
      (data.detail as string | undefined);
    const msg =
      typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : typeof err === "string"
          ? err
          : text.slice(0, 400);
    const extra =
      nodeErrors && typeof nodeErrors === "object"
        ? ` node_errors=${JSON.stringify(nodeErrors).slice(0, 800)}`
        : "";
    throw new Error(`ComfyUI /prompt failed ${res.status}: ${msg}${extra}`);
  }
  const prompt_id = typeof data.prompt_id === "string" ? data.prompt_id : "";
  if (!prompt_id) throw new Error(`ComfyUI /prompt: no prompt_id in ${text.slice(0, 300)}`);
  return {
    prompt_id,
    number: typeof data.number === "number" ? data.number : undefined,
  };
}

type HistoryEntry = {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<
    string,
    { images?: Array<{ filename: string; subfolder?: string; type?: string }> }
  >;
};

function parseHistoryPayload(text: string): Record<string, HistoryEntry> {
  try {
    return text ? (JSON.parse(text) as Record<string, HistoryEntry>) : {};
  } catch {
    return {};
  }
}

/** Poll until prompt_id completes or timeout. Returns first output image ref if any. */
export async function comfyWaitForOutputImage(
  baseUrl: string,
  promptId: string,
  options?: { timeoutMs?: number; pollMs?: number }
): Promise<{ filename: string; subfolder: string; type: string }> {
  const base = trimBaseUrl(baseUrl);
  const timeoutMs = options?.timeoutMs ?? 420_000;
  const pollMs = options?.pollMs ?? 750;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let entry: HistoryEntry | undefined;

    const direct = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
    if (direct.ok) {
      const raw = await direct.text();
      const parsed = parseHistoryPayload(raw);
      if (parsed[promptId]) {
        entry = parsed[promptId];
      } else if (parsed.status || parsed.outputs) {
        entry = parsed as unknown as HistoryEntry;
      }
    }

    if (!entry) {
      const all = await fetch(`${base}/history`);
      if (all.ok) {
        const raw = await all.text();
        const parsed = parseHistoryPayload(raw);
        entry = parsed[promptId];
      }
    }

    const statusStr =
      entry?.status && typeof (entry.status as { status_str?: string }).status_str === "string"
        ? (entry.status as { status_str: string }).status_str
        : "";
    if (statusStr === "error" || statusStr === "failed") {
      throw new Error(
        `ComfyUI run failed for ${promptId}: ${JSON.stringify(entry?.status).slice(0, 400)}`
      );
    }

    if (entry?.outputs) {
      for (const nodeOut of Object.values(entry.outputs)) {
        const img = nodeOut?.images?.[0];
        if (img?.filename) {
          return {
            filename: img.filename,
            subfolder: typeof img.subfolder === "string" ? img.subfolder : "",
            type: typeof img.type === "string" ? img.type : "output",
          };
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`ComfyUI: timeout waiting for prompt ${promptId} (${timeoutMs}ms)`);
}

export async function comfyImageToDataUri(
  baseUrl: string,
  filename: string,
  subfolder: string,
  type: string
): Promise<string> {
  const base = trimBaseUrl(baseUrl);
  const q = new URLSearchParams({
    filename,
    type,
    subfolder,
  });
  const res = await fetch(`${base}/view?${q.toString()}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ComfyUI /view failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/png";
  return `data:${ct};base64,${buf.toString("base64")}`;
}
