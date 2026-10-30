/**
 * Shared Cloudinary uploads for public media Modal (and others) can GET.
 * Prefers unsigned upload preset (CLOUDINARY_UPLOAD_PRESET) so restricted API keys still work.
 */
import fs from "fs";
import path from "path";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

let configured = false;

function cloudName(): string {
  return String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
}

function uploadPreset(): string {
  return String(process.env.CLOUDINARY_UPLOAD_PRESET || "").trim();
}

function hasSignedCreds(): boolean {
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  const cloudinaryUrl = String(process.env.CLOUDINARY_URL || "").trim();
  return Boolean(cloudinaryUrl || (apiKey && apiSecret));
}

export function isCloudinaryConfigured(): boolean {
  // Unsigned preset only needs cloud name + preset name.
  if (cloudName() && uploadPreset()) return true;
  return Boolean(cloudName() && hasSignedCreds());
}

export function initCloudinary(): boolean {
  if (configured) return true;
  if (!isCloudinaryConfigured()) return false;
  const name = cloudName();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  const cloudinaryUrl = String(process.env.CLOUDINARY_URL || "").trim();
  if (cloudinaryUrl) {
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: name,
      api_key: apiKey || undefined,
      api_secret: apiSecret || undefined,
      secure: true,
    });
  }
  configured = true;
  return true;
}

function assertCloudinary(): void {
  if (!initCloudinary()) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET (or API key/secret)."
    );
  }
}

function resourceTypeForExt(ext: string): "video" | "image" | "raw" {
  const e = ext.toLowerCase();
  if ([".mp4", ".mov", ".webm", ".m4v"].includes(e)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(e)) return "image";
  return "raw";
}

export type CloudinaryUploadOpts = {
  folder?: string;
  publicId?: string;
  resourceType?: "video" | "image" | "raw" | "auto";
  overwrite?: boolean;
};

export async function uploadBufferToCloudinary(
  buf: Buffer,
  opts: CloudinaryUploadOpts & { filenameHint?: string } = {}
): Promise<string> {
  assertCloudinary();
  const ext = path.extname(opts.filenameHint || "").toLowerCase() || ".bin";
  const resource_type = opts.resourceType || resourceTypeForExt(ext);
  const preset = uploadPreset();

  // Data URI works with unsigned_upload without needing a signed stream.
  if (preset) {
    const mime = mediaContentTypeForPath(`x${ext}`);
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    const result = await cloudinary.uploader.unsigned_upload(dataUri, preset, {
      public_id: opts.publicId,
      resource_type,
    });
    if (!result?.secure_url) {
      throw new Error("Cloudinary upload succeeded but secure_url was missing");
    }
    return result.secure_url;
  }

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder || "xevo/uploads",
        public_id: opts.publicId,
        resource_type,
        overwrite: opts.overwrite ?? true,
        type: "upload",
      },
      (err, res) => {
        if (err || !res) reject(err || new Error("Cloudinary upload returned empty result"));
        else resolve(res);
      }
    );
    stream.end(buf);
  });
  if (!result.secure_url) {
    throw new Error("Cloudinary upload succeeded but secure_url was missing");
  }
  return result.secure_url;
}

/** Upload a local file (video/image) and return a public HTTPS URL Modal can fetch. */
export async function uploadLocalFileToCloudinary(
  absPath: string,
  opts: CloudinaryUploadOpts = {}
): Promise<string> {
  assertCloudinary();
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found for Cloudinary upload: ${absPath}`);
  }
  const ext = path.extname(absPath).toLowerCase();
  const resource_type = opts.resourceType || resourceTypeForExt(ext);
  const preset = uploadPreset();

  if (preset) {
    const result = await cloudinary.uploader.unsigned_upload(absPath, preset, {
      public_id: opts.publicId,
      resource_type,
    });
    if (!result?.secure_url) {
      throw new Error("Cloudinary upload succeeded but secure_url was missing");
    }
    return result.secure_url;
  }

  const result = await cloudinary.uploader.upload(absPath, {
    folder: opts.folder || "xevo/uploads",
    public_id: opts.publicId,
    resource_type,
    overwrite: opts.overwrite ?? true,
    type: "upload",
  });
  if (!result?.secure_url) {
    throw new Error("Cloudinary upload succeeded but secure_url was missing");
  }
  return result.secure_url;
}

export function cloudinaryStagingFailureMessage(e: unknown): {
  error: string;
  detail: string;
  feedbackText: string;
} {
  const detail = e instanceof Error ? e.message : String(e);
  const cause =
    e instanceof Error && e.cause && typeof e.cause === "object"
      ? (e.cause as { code?: string; hostname?: string; message?: string })
      : null;
  const code =
    cause?.code ??
    (typeof (e as { code?: string })?.code === "string" ? (e as { code: string }).code : "");
  const blob = `${detail} ${cause?.message ?? ""} ${cause?.hostname ?? ""} ${code}`;
  if (/ENOTFOUND|getaddrinfo/i.test(blob) || code === "ENOTFOUND") {
    const msg =
      "Could not reach Cloudinary to stage the video (DNS failed). Check this machine’s internet/DNS/VPN, then retry.";
    return { error: msg, detail, feedbackText: msg };
  }
  if (
    /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(blob) ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"
  ) {
    const msg =
      "Could not reach Cloudinary to stage the video (network error). Check server internet connectivity and retry.";
    return { error: msg, detail, feedbackText: msg };
  }
  if (/403|Unauthorized|not allowed/i.test(blob)) {
    const msg =
      "Cloudinary rejected the upload (403). Check CLOUDINARY_UPLOAD_PRESET / API key upload permissions.";
    return { error: msg, detail, feedbackText: msg };
  }
  if (/not configured|CLOUDINARY_/i.test(detail)) {
    const msg =
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET (or API key/secret).";
    return { error: msg, detail, feedbackText: msg };
  }
  const msg =
    "Could not stage video for Modal analysis on Cloudinary. Check Cloudinary credentials and server logs.";
  return { error: msg, detail, feedbackText: msg };
}

export function mediaContentTypeForPath(absPath: string): string {
  const e = path.extname(absPath).toLowerCase();
  if (e === ".mp4") return "video/mp4";
  if (e === ".mov") return "video/quicktime";
  if (e === ".webm") return "video/webm";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  return "application/octet-stream";
}
