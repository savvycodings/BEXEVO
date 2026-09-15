import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);

/**
 * Generates a tiny synthetic mp4 with ffmpeg's testsrc pattern instead of checking a real
 * video fixture into git. /technique/upload only requires a valid MP4/MOV container; nothing
 * downstream in this test suite depends on the actual visual content.
 */
export async function makeFixtureVideo(opts?: {
  seconds?: number;
  width?: number;
  height?: number;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const seconds = opts?.seconds ?? 2;
  const width = opts?.width ?? 640;
  const height = opts?.height ?? 480;

  if (!ffmpegStatic) throw new Error("ffmpeg-static did not resolve a binary path");

  const outPath = path.join(os.tmpdir(), `xevo-e2e-fixture-${Date.now()}.mp4`);
  await execFileAsync(ffmpegStatic, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${width}x${height}:rate=15`,
    "-t",
    String(seconds),
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);

  return {
    path: outPath,
    cleanup: async () => {
      await fs.promises.unlink(outPath).catch(() => {});
    },
  };
}
