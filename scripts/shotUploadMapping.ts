/**
 * Maps shots/ folder paths → Admin Train upload API fields (same as AdminTrain.tsx).
 */

export type TrainCategory =
  | "ground_strokes"
  | "net_play"
  | "defence_glass"
  | "save_return"
  | "overhead"
  | "tactical_specials";

export type TrainStrokePreset =
  | "forehand_drive"
  | "backhand_drive"
  | "forehand_lob"
  | "backhand_lob"
  | "backhand_volley"
  | "forehand_volley"
  | "backhand_return"
  | "backhand_return_with_lob"
  | "forehand_return_with_lob"
  | "backhand_drive_with_wall"
  | "forehand_chiquita"
  | "half_volley"
  | "back_wall_backhand"
  | "back_wall_forehand"
  | "contrapared_boast"
  | "side_wall_backhand"
  | "side_wall_forehand"
  | "bandeja";

export type ViewProfile = "front" | "side" | "behind";

export type ShotManifestEntry = {
  filePath: string;
  relativePath: string;
  groupFolder: string;
  shotFolder: string;
  cameraFolder: string;
  category: TrainCategory;
  strokePreset: TrainStrokePreset;
  strokeLabel: string;
  skillLevel: "beginner" | "intermediate" | "advanced";
  viewProfile: ViewProfile;
  /** True when 45°/Diagonal folder mapped to `side` (API has no diagonal enum). */
  diagonalMappedToSide: boolean;
  sizeBytes: number;
};

const GROUP_TO_CATEGORY: Record<string, TrainCategory> = {
  serves: "save_return",
  returns: "save_return",
  groundstrokes: "ground_strokes",
  lobs: "ground_strokes",
  chiquitas: "ground_strokes",
  volleys: "net_play",
  overheads: "overhead",
};

/** Shot folders excluded until reshoot (see remove-train-shots.ts). */
export const SKIPPED_SHOT_FOLDERS = new Set(["flatserve", "sliceserve"]);

const SHOT_TO_META: Record<
  string,
  { strokeLabel: string; strokePreset: TrainStrokePreset }
> = {
  forehanddrive: { strokeLabel: "Forehand Drive 1", strokePreset: "forehand_drive" },
  backhanddrive: { strokeLabel: "Backhand Drive", strokePreset: "backhand_drive" },
  forehandlob: { strokeLabel: "Forehand Lob", strokePreset: "forehand_lob" },
  backhandlob: { strokeLabel: "Backhand Lob 1", strokePreset: "backhand_lob" },
  chiquitarevez: { strokeLabel: "Chiquita revez", strokePreset: "backhand_drive" },
  forehandvolley: { strokeLabel: "Forehand Volley", strokePreset: "forehand_volley" },
  backhandvolley: { strokeLabel: "Backhand Volley 1", strokePreset: "backhand_volley" },
  forehandreturn: { strokeLabel: "Forehand Return", strokePreset: "forehand_return_with_lob" },
  backhandreturn: { strokeLabel: "Backhand Return", strokePreset: "backhand_return" },
  "bandeja(jump)": { strokeLabel: "Bandeja (jump)", strokePreset: "bandeja" },
  bandeja1: { strokeLabel: "Bandeja 1", strokePreset: "bandeja" },
};

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function parseViewProfile(cameraFolder: string): {
  viewProfile: ViewProfile;
  diagonalMappedToSide: boolean;
} {
  const c = cameraFolder.trim().toLowerCase();
  if (c === "frontcamera" || c.startsWith("front")) {
    return { viewProfile: "front", diagonalMappedToSide: false };
  }
  if (c === "backcamera" || c.startsWith("back")) {
    return { viewProfile: "behind", diagonalMappedToSide: false };
  }
  if (c.includes("side")) {
    return { viewProfile: "side", diagonalMappedToSide: false };
  }
  // 45°, Diagonal, garbled encoding — API only supports front|side|behind; use side.
  if (
    c.includes("45") ||
    c.includes("diagonal") ||
    c.includes("diag") ||
    c === "" ||
    /[^\x20-\x7e]/.test(cameraFolder)
  ) {
    return { viewProfile: "side", diagonalMappedToSide: true };
  }
  return { viewProfile: "side", diagonalMappedToSide: false };
}

export function mapShotsRelativePath(
  relativePath: string,
  sizeBytes: number,
  defaultSkillLevel: "beginner" | "intermediate" | "advanced" = "intermediate"
): ShotManifestEntry {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 4) {
    throw new Error(`Expected shots/{Group}/{Shot}/{Camera}/file.mp4 — got: ${relativePath}`);
  }
  const [groupFolder, shotFolder, cameraFolder, fileName] = [
    parts[0],
    parts[1],
    parts[2],
    parts[parts.length - 1],
  ];
  if (!fileName.toLowerCase().endsWith(".mp4")) {
    throw new Error(`Not an mp4: ${relativePath}`);
  }

  const category = GROUP_TO_CATEGORY[normKey(groupFolder)];
  if (!category) {
    throw new Error(`Unknown group folder "${groupFolder}" in ${relativePath}`);
  }

  const shotKey = normKey(shotFolder);
  if (SKIPPED_SHOT_FOLDERS.has(shotKey)) {
    throw new Error(`Skipped shot folder "${shotFolder}" (removed from train library until reshoot)`);
  }
  const meta = SHOT_TO_META[shotKey] ?? SHOT_TO_META[shotFolder.toLowerCase()];
  if (!meta) {
    throw new Error(`Unknown shot folder "${shotFolder}" in ${relativePath}`);
  }

  const { viewProfile, diagonalMappedToSide } = parseViewProfile(cameraFolder);

  return {
    filePath: "",
    relativePath,
    groupFolder,
    shotFolder,
    cameraFolder,
    category,
    strokePreset: meta.strokePreset,
    strokeLabel: meta.strokeLabel,
    skillLevel: defaultSkillLevel,
    viewProfile,
    diagonalMappedToSide,
    sizeBytes,
  };
}

export function manifestDedupeKey(e: ShotManifestEntry): string {
  return [
    e.category,
    e.strokePreset,
    e.skillLevel,
    e.viewProfile,
    e.strokeLabel,
    e.diagonalMappedToSide ? "diag" : "std",
  ].join("|");
}
