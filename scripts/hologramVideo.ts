/**
 * Padel clip -> hologram videos (standalone, no DB, no HTTP route).
 *
 *   1-2  ffmpeg: impact frame, square crop             -> 00-impact-frame.png
 *   3    GPT Image: frame + style -> faceless hologram  -> 01-hologram.png
 *   4    GPT Image: hologram + style -> same player, T-pose -> 02-tpose.png
 *   5    GPT Image: T-pose + style -> racket, court fence, wider shot -> 03-avatar.png
 *   6    upload: fal storage (--provider fal, default) or Cloudflare R2 presigned links (--provider higgsfield)
 *   7    Seedance 2.5 image-to-video: 360 turntable of 01-hologram -> 360-turntable.mp4
 *   8    Seedance 2.5 video-edit: original clip restyled with the avatars -> 3d-shot.mp4
 *   9    everything + run.json (prompts, request ids, timings) in --out
 *
 * Steps whose output already exists in --out are skipped, so a rerun only pays for what failed.
 * Run without --impact to get a contact sheet (00-contact-sheet.png) for picking the impact time.
 *
 * Usage:
 *   npx tsx scripts/hologramVideo.ts --video clip.mp4 --style style.png --impact 1.42 \
 *     [--out dir] [--cx 0.5] [--cy 0.5] [--image-model gpt-image-2] [--quality high] \
 *     [--resolution 720p] [--duration 5] [--turntable-image hologram|avatar] \
 *     [--only images|videos] [--provider fal|higgsfield] [--draft] [--dry-run]
 *
 * --draft asks fal's Seedance for a cheaper preview render.
 *
 * Env: OPENAI_API_KEY, plus FAL_KEY (--provider fal) or
 *      HF_API_KEY_ID + HF_API_KEY_SECRET (or HF_KEY="id:secret") and
 *      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (--provider higgsfield).
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fal } from "@fal-ai/client";

const PROMPTS = {
  hologram:
    "Image 1 is a frame from a padel video. Image 2 is the style reference. " +
    "Turn the player in image 1 into a 3D hologram in exactly the style of image 2: translucent electric-blue " +
    "body made of a fine wireframe mesh with glowing joint nodes, cyan edge light. Keep the exact pose, body " +
    "proportions, camera angle and framing of image 1, and keep the ball. The hologram has no face: a smooth, " +
    "featureless head. No reflections. Remove the court fence, the glass walls and the net; keep only the blue " +
    "court floor with its white lines, against a dark navy background. Nothing in front of the player.",
  tpose:
    "Image 1 is a hologram padel player. Image 2 is the style reference. Show the same player (same body, " +
    "clothing silhouette and hologram style) standing upright in a neutral T-pose, arms straight out to the " +
    "sides, facing the camera, full body, centered. Faceless head, no racket, no ball, no reflections. " +
    "Only the blue court floor, dark navy background.",
  avatar:
    "Image 1 is a hologram padel player in a T-pose. Image 2 is the style reference. Keep the same player and " +
    "T-pose, and add a padel racket (solid perforated face, no strings) in the right hand, rendered in the same " +
    "glowing hologram style. Show the court around them: black mesh fence and glass walls outlined by thin " +
    "neon-blue light strips, blue court floor with white lines. Pull the camera back so the full body and the " +
    "court are visible. Faceless head.",
  turntable:
    "Full 360-degree turntable of the player, bullet-time. The holographic player is completely frozen in this " +
    "pose, like a statue; the camera does all the moving. The camera orbits a full circle around the player at " +
    "chest height at constant speed: it starts at this view, passes the player's side, shows the player's back " +
    "at the halfway point, passes the other side and ends back at this exact view. The court floor lines rotate " +
    "beneath the player as the camera circles. No body movement, no cuts, no zoom.",
  videoEdit:
    "Restyle the player as the holographic avatar in the reference images: translucent electric-blue wireframe " +
    "body with glowing joint nodes, faceless head, glowing racket. Keep the exact motion, timing, camera and " +
    "framing of the source video. Turn the court into a dark navy night court with neon-blue light strips on " +
    "the fence and glowing white lines. The ball stays a glowing yellow-green.",
  // fal's reference-to-video addresses inputs by position
  videoEditFal:
    "Edit @Video1: restyle the player as the holographic avatar in @Image1 and @Image2: translucent " +
    "electric-blue wireframe body with glowing joint nodes, faceless head, glowing racket. Keep the exact motion, " +
    "timing, camera and framing of @Video1. Turn the court into a dark navy night court with neon-blue light " +
    "strips on the fence and glowing white lines. The ball stays a glowing yellow-green.",
};

type Args = {
  video: string;
  style: string;
  impact?: number;
  out: string;
  cx: number;
  cy: number;
  imageModel: string;
  quality: string;
  resolution: string;
  duration: number;
  turntableImage: "hologram" | "avatar";
  only?: "images" | "videos";
  provider: "fal" | "higgsfield";
  draft: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) bools.add(a.slice(2));
    else flags.set(a.slice(2), argv[++i]);
  }
  const video = flags.get("video");
  const style = flags.get("style");
  if (!video || !style) {
    console.error("Usage: npx tsx scripts/hologramVideo.ts --video clip.mp4 --style style.png [--impact <sec>] [...]");
    process.exit(1);
  }
  const stem = path.basename(video, path.extname(video)).replace(/[^\w-]+/g, "_");
  return {
    video: path.resolve(video),
    style: path.resolve(style),
    impact: flags.has("impact") ? Number(flags.get("impact")) : undefined,
    out: path.resolve(flags.get("out") ?? `uploads/hologram/${stem}`),
    cx: Number(flags.get("cx") ?? 0.5),
    cy: Number(flags.get("cy") ?? 0.5),
    imageModel: flags.get("image-model") ?? "gpt-image-2",
    quality: flags.get("quality") ?? "high",
    resolution: flags.get("resolution") ?? "720p",
    duration: Number(flags.get("duration") ?? 5),
    turntableImage: flags.get("turntable-image") === "avatar" ? "avatar" : "hologram",
    only: flags.get("only") as Args["only"],
    provider: flags.get("provider") === "higgsfield" ? "higgsfield" : "fal",
    draft: bools.has("draft"),
    dryRun: bools.has("dry-run"),
  };
}

function ffmpeg(args: string[]) {
  execFileSync(ffmpegPath as unknown as string, ["-y", "-v", "error", ...args], { stdio: "inherit" });
}

/** 4x3 grid at 4 fps over the first 3 s, each tile stamped with its timestamp. */
function writeContactSheet(video: string, outFile: string) {
  ffmpeg([
    "-i", video,
    "-vf",
    "fps=4,scale=320:-1,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=4x3",
    "-frames:v", "1", outFile,
  ]);
}

/** Frame at `t` seconds, cropped to the largest square around (cx, cy), scaled to 1024. */
function extractSquareFrame(video: string, t: number, cx: number, cy: number, outFile: string) {
  const crop = `crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))*${cx}':'(ih-min(iw,ih))*${cy}'`;
  ffmpeg(["-ss", String(t), "-i", video, "-frames:v", "1", "-vf", `${crop},scale=1024:1024`, outFile]);
}

async function gptImageEdit(model: string, quality: string, prompt: string, images: string[], outFile: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  form.append("quality", quality);
  for (const img of images) {
    form.append("image[]", new Blob([fs.readFileSync(img)], { type: "image/png" }), path.basename(img));
  }
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`OpenAI images/edits ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  fs.writeFileSync(outFile, Buffer.from(body.data[0].b64_json, "base64"));
  return { requestId: res.headers.get("x-request-id"), usage: body.usage };
}

function r2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set");
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return { client, bucket: R2_BUCKET };
}

/** Uploads to the private bucket and returns a GET link valid for an hour (Higgsfield may queue first). */
async function uploadPresigned(file: string, key: string, contentType: string) {
  const { client, bucket } = r2Client();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(file), ContentType: contentType }));
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
}

function higgsfieldAuth() {
  const id = process.env.HF_API_KEY_ID;
  const secret = process.env.HF_API_KEY_SECRET;
  const key = id && secret ? `${id}:${secret}` : process.env.HF_KEY;
  if (!key) throw new Error("HF_API_KEY_ID + HF_API_KEY_SECRET (or HF_KEY) must be set");
  return `Key ${key}`;
}

const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);

/** Submit, poll status_url (2 s backoff to 10 s, 20 min cap), download video.url. */
async function higgsfieldVideo(endpoint: string, body: object, idempotencyKey: string, outFile: string, label: string) {
  const auth = higgsfieldAuth();
  const submit = await fetch(`https://api.higgsfield.ai/${endpoint}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const handle: any = await submit.json();
  if (!submit.ok) throw new Error(`${endpoint} ${submit.status}: ${JSON.stringify(handle)}`);
  console.log(`[${label}] queued ${handle.request_id}`);

  const started = Date.now();
  let delay = 2000;
  let result: any = handle;
  while (!TERMINAL.has(result.status)) {
    if (Date.now() - started > 20 * 60_000) throw new Error(`[${label}] timed out after 20 min (${handle.request_id})`);
    await new Promise((r) => setTimeout(r, delay + Math.random() * 500));
    delay = Math.min(delay * 1.5, 10_000);
    const res = await fetch(handle.status_url, { headers: { Authorization: auth } });
    if (res.status === 401 || res.status === 404) throw new Error(`[${label}] status ${res.status}: ${await res.text()}`);
    if (!res.ok) continue; // 5xx / transient: keep polling
    const next: any = await res.json();
    if (next.status !== result.status) console.log(`[${label}] ${next.status} (${Math.round((Date.now() - started) / 1000)}s)`);
    result = next;
  }
  if (result.status !== "completed") throw new Error(`[${label}] ${result.status}: ${JSON.stringify(result)}`);

  const video = await fetch(result.video.url);
  if (!video.ok) throw new Error(`[${label}] download ${video.status}`);
  fs.writeFileSync(outFile, Buffer.from(await video.arrayBuffer()));
  return { requestId: handle.request_id, seconds: Math.round((Date.now() - started) / 1000) };
}

function falConfigure() {
  // BEXevo's .env names it FAL_API_KEY
  const key = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_KEY (or FAL_API_KEY) must be set");
  fal.config({ credentials: key });
}

/** fal storage: unguessable but non-expiring URL (fal.media). */
async function falUpload(file: string, contentType: string) {
  return fal.storage.upload(new Blob([fs.readFileSync(file)], { type: contentType }));
}

/** fal queue: submit, wait (20 min cap), download video.url. */
async function falVideo(endpoint: string, input: object, outFile: string, label: string) {
  const started = Date.now();
  let last = "";
  const result: any = await fal.subscribe(endpoint, {
    input,
    timeout: 20 * 60_000,
    onEnqueue: (requestId) => console.log(`[${label}] queued ${requestId}`),
    onQueueUpdate: (update) => {
      if (update.status !== last) console.log(`[${label}] ${update.status} (${Math.round((Date.now() - started) / 1000)}s)`);
      last = update.status;
    },
  });
  const video = await fetch(result.data.video.url);
  if (!video.ok) throw new Error(`[${label}] download ${video.status}`);
  fs.writeFileSync(outFile, Buffer.from(await video.arrayBuffer()));
  return { requestId: result.requestId, seed: result.data.seed, seconds: Math.round((Date.now() - started) / 1000) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const out = (name: string) => path.join(args.out, name);
  const manifestFile = out("run.json");
  const manifest: any = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { runId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  Object.assign(manifest, { args, prompts: PROMPTS });
  manifest.steps ??= {};
  const save = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  save();

  if (args.impact === undefined) {
    writeContactSheet(args.video, out("00-contact-sheet.png"));
    console.log(`No --impact given. Pick the impact time from ${out("00-contact-sheet.png")} and rerun.`);
    return;
  }

  // 1-2. Impact frame
  const frame = out("00-impact-frame.png");
  const style = out("00-style.png");
  if (!fs.existsSync(frame)) extractSquareFrame(args.video, args.impact, args.cx, args.cy, frame);
  if (!fs.existsSync(style)) ffmpeg(["-i", args.style, style]);
  console.log(`frame: ${frame}`);

  // 3-5. GPT Image chain; the style reference goes with every call
  const hologram = out("01-hologram.png");
  const tpose = out("02-tpose.png");
  const avatar = out("03-avatar.png");
  const imageSteps: [string, string, string, string][] = [
    ["hologram", PROMPTS.hologram, frame, hologram],
    ["tpose", PROMPTS.tpose, hologram, tpose],
    ["avatar", PROMPTS.avatar, tpose, avatar],
  ];
  if (args.only !== "videos") {
    for (const [name, prompt, input, outFile] of imageSteps) {
      if (fs.existsSync(outFile)) {
        console.log(`[${name}] exists, skipping`);
        continue;
      }
      if (args.dryRun) {
        console.log(`[${name}] dry run: ${args.imageModel} edit of ${path.basename(input)} + style -> ${path.basename(outFile)}`);
        continue;
      }
      const t0 = Date.now();
      console.log(`[${name}] ${args.imageModel} ...`);
      const info = await gptImageEdit(args.imageModel, args.quality, prompt, [input, style], outFile);
      manifest.steps[name] = { ...info, seconds: Math.round((Date.now() - t0) / 1000) };
      save();
      console.log(`[${name}] -> ${outFile}`);
    }
  }
  if (args.only === "images") return;

  // 6-8. Upload, then both Seedance jobs in parallel
  const turntableOut = out("360-turntable.mp4");
  const editOut = out("3d-shot.mp4");
  const turntableSrc = args.turntableImage === "avatar" ? avatar : hologram;
  const needed = [turntableSrc, avatar, hologram].filter((f) => !fs.existsSync(f));
  if (needed.length && !args.dryRun) throw new Error(`Missing avatar images: ${needed.join(", ")}`);
  const onFal = args.provider === "fal";
  if (args.dryRun) {
    console.log(`[upload] dry run: 01-hologram.png, 03-avatar.png, source video -> ${onFal ? "fal storage" : "R2 (1 h links)"}`);
    console.log(`[turntable] dry run: ${args.provider} seedance-2.5/image-to-video ${args.duration}s ${args.resolution}${args.draft ? " draft" : ""}`);
    console.log(`[video-edit] dry run: ${args.provider} seedance-2.5/${onFal ? "reference-to-video (editing)" : "video-edit"} ${args.resolution}`);
    return;
  }

  const prefix = `hologram/${manifest.runId}`;
  if (onFal) falConfigure();
  const upload = (file: string, name: string, contentType: string) =>
    onFal ? falUpload(file, contentType) : uploadPresigned(file, `${prefix}/${name}`, contentType);
  const jobs: Promise<void>[] = [];
  if (!fs.existsSync(turntableOut)) {
    jobs.push(
      (async () => {
        const imageUrl = await upload(turntableSrc, path.basename(turntableSrc), "image/png");
        const input = { image_url: imageUrl, prompt: PROMPTS.turntable, resolution: args.resolution, generate_audio: false };
        manifest.steps.turntable = onFal
          ? await falVideo(
              "bytedance/seedance-2.5/image-to-video",
              { ...input, duration: String(args.duration), ...(args.draft ? { draft: true } : {}) },
              turntableOut,
              "turntable",
            )
          : await higgsfieldVideo(
              "bytedance/seedance-2.5/image-to-video",
              { ...input, duration: args.duration },
              `${manifest.runId}-turntable`,
              turntableOut,
              "turntable",
            );
        save();
        console.log(`[turntable] -> ${turntableOut}`);
      })(),
    );
  }
  if (!fs.existsSync(editOut)) {
    jobs.push(
      (async () => {
        const [videoUrl, avatarUrl, hologramUrl] = await Promise.all([
          upload(args.video, `source${path.extname(args.video)}`, "video/mp4"),
          upload(avatar, "03-avatar.png", "image/png"),
          upload(hologram, "01-hologram.png", "image/png"),
        ]);
        manifest.steps.videoEdit = onFal
          ? await falVideo(
              "bytedance/seedance-2.5/reference-to-video",
              {
                prompt: PROMPTS.videoEditFal,
                task: "editing",
                video_urls: [videoUrl],
                image_urls: [avatarUrl, hologramUrl],
                resolution: args.resolution,
                generate_audio: false,
                ...(args.draft ? { draft: true } : {}),
              },
              editOut,
              "video-edit",
            )
          : await higgsfieldVideo(
              "bytedance/seedance-2.5/video-edit",
              { prompt: PROMPTS.videoEdit, video_url: videoUrl, image_urls: [avatarUrl, hologramUrl], resolution: args.resolution, generate_audio: false },
              `${manifest.runId}-video-edit`,
              editOut,
              "video-edit",
            );
        save();
        console.log(`[video-edit] -> ${editOut}`);
      })(),
    );
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  for (const f of failed) console.error(f.reason);
  console.log(`\nAll outputs in ${args.out}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
