import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mapShotsRelativePath, type ShotManifestEntry } from "./shotUploadMapping";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XEVO_ROOT = path.resolve(__dirname, "../..");
const SHOTS_DIR = path.resolve(XEVO_ROOT, "shots");
const OUT_JSON = path.resolve(XEVO_ROOT, "shots-upload-manifest.json");
const OUT_MD = path.resolve(XEVO_ROOT, "shots-upload-manifest.md");

function walkMp4(dir: string, base: string, out: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkMp4(full, base, out);
    } else if (name.toLowerCase().endsWith(".mp4")) {
      out.push(path.relative(base, full));
    }
  }
}

function toMarkdown(entries: ShotManifestEntry[]): string {
  const diagonalCount = entries.filter((e) => e.diagonalMappedToSide).length;
  const lines: string[] = [
    "# Shots upload manifest",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Total clips: **${entries.length}**`,
    `Diagonal/45° folders mapped to \`viewProfile: side\`: **${diagonalCount}**`,
    "",
    "| # | File | category | strokeLabel | strokePreset | skillLevel | viewProfile | diagonal→side | MB |",
    "|---|------|----------|-------------|--------------|------------|-------------|---------------|-----|",
  ];

  entries.forEach((e, i) => {
    const mb = (e.sizeBytes / (1024 * 1024)).toFixed(2);
    lines.push(
      `| ${i + 1} | \`${e.relativePath}\` | ${e.category} | ${e.strokeLabel} | ${e.strokePreset} | ${e.skillLevel} | ${e.viewProfile} | ${e.diagonalMappedToSide ? "yes" : ""} | ${mb} |`
    );
  });

  lines.push(
    "",
    "## Diagonal / 45° camera folders",
    "",
    "The Admin API only accepts `front`, `side`, or `behind`. Clips from folders named `45°`, `Diagonal`, or similar are uploaded with **`viewProfile: side`** (same physical angle family as side camera).",
    "",
    ...(diagonalCount > 0
      ? entries
          .filter((e) => e.diagonalMappedToSide)
          .map((e) => `- \`${e.relativePath}\` (folder: \`${e.cameraFolder}\`)`)
      : ["_None_"]),
    "",
    "## Upload",
    "",
    "```bash",
    "cd server",
    "pnpm exec tsx scripts/upload-shots-batch.ts --dry-run   # preview",
    "pnpm exec tsx scripts/upload-shots-batch.ts             # upload one-by-one",
    "```",
    ""
  );
  return lines.join("\n");
}

async function main() {
  if (!fs.existsSync(SHOTS_DIR)) {
    console.error("shots/ not found at", SHOTS_DIR);
    process.exit(1);
  }

  const relPaths: string[] = [];
  walkMp4(SHOTS_DIR, SHOTS_DIR, relPaths);
  relPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const skillLevel =
    (process.env.TRAIN_UPLOAD_SKILL_LEVEL as "beginner" | "intermediate" | "advanced") ||
    "intermediate";

  const entries: ShotManifestEntry[] = [];
  const errors: string[] = [];

  for (const rel of relPaths) {
    const abs = path.join(SHOTS_DIR, rel);
    const sizeBytes = fs.statSync(abs).size;
    try {
      const entry = mapShotsRelativePath(rel, sizeBytes, skillLevel);
      entry.filePath = abs;
      entries.push(entry);
    } catch (e) {
      errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    shotsDir: SHOTS_DIR,
    skillLevelDefault: skillLevel,
    diagonalMappedToSideCount: entries.filter((e) => e.diagonalMappedToSide).length,
    entries,
    errors,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(OUT_MD, toMarkdown(entries), "utf8");

  console.log(`Wrote ${entries.length} entries → ${OUT_JSON}`);
  console.log(`Wrote markdown → ${OUT_MD}`);
  if (errors.length) {
    console.error("Mapping errors:", errors);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
