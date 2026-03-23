import { execFile } from "child_process";
import path from "path";
import ffmpegStatic from "ffmpeg-static";

function resolveFfmpegBinary(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (ffmpegStatic) return ffmpegStatic;
  return "ffmpeg";
}

export function extractFrame(
  videoPath: string,
  frameNumber: number
): Promise<Buffer> {
  const filters = [
    `select=eq(n\\,${frameNumber})`,
    `select=gte(n\\,${frameNumber})`,
  ];

  return new Promise(async (resolve, reject) => {
    for (const vf of filters) {
      try {
        const frame = await runFfmpegExtract(videoPath, vf);
        if (frame.length > 0) {
          return resolve(frame);
        }
      } catch {
      }
    }
    reject(
      new Error(
        `ffmpeg extraction failed for frame ${frameNumber} with all filter strategies`
      )
    );
  });
}

function runFfmpegExtract(videoPath: string, vf: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      videoPath,
      "-vf",
      vf,
      "-vsync",
      "vfr",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-y",
      "pipe:1",
    ];

    const outBuffers: Buffer[] = [];
    const errBuffers: Buffer[] = [];
    const ffmpegBin = resolveFfmpegBinary();
    const proc = execFile(ffmpegBin, args, {
      maxBuffer: 20 * 1024 * 1024,
      encoding: "buffer" as any,
    });

    proc.stdout?.on("data", (chunk: Buffer) => outBuffers.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => errBuffers.push(chunk));

    proc.on("close", (code) => {
      const stderr = Buffer.concat(errBuffers).toString("utf8");
      const hasFilterError =
        /error|invalid|failed/i.test(stderr) &&
        /select|filter|vf|expression/i.test(stderr);
      if (code === 0 && outBuffers.length > 0 && !hasFilterError) {
        resolve(Buffer.concat(outBuffers));
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}; vf=${vf}; stderr=${stderr
              .slice(0, 300)
              .replace(/\s+/g, " ")}`
          )
        );
      }
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `ffmpeg not found or failed to start (binary: ${resolveFfmpegBinary()}): ${err.message}`
        )
      );
    });
  });
}

export function resolveVideoPath(cloudinaryPublicId: string): string {
  if (path.isAbsolute(cloudinaryPublicId)) return cloudinaryPublicId;
  return path.join(process.cwd(), cloudinaryPublicId);
}
