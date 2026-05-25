import assert from "node:assert/strict";
import test from "node:test";
import {
  trainCategoryEnum,
  trainSkillLevelEnum,
  trainStrokePresetEnum,
} from "../db/schema";

/** Mirror of `app/src/lib/train-taxonomy.ts` TrainStrokePreset ids — drift guard. */
const APP_TRAIN_STROKE_PRESET_IDS = [
  "forehand_drive",
  "backhand_drive",
  "forehand_lob",
  "backhand_lob",
  "forehand_chiquita",
  "backhand_drive_with_wall",
  "forehand_volley",
  "backhand_volley",
  "half_volley",
  "backhand_return",
  "backhand_return_with_lob",
  "forehand_return_with_lob",
  "back_wall_backhand",
  "back_wall_forehand",
  "side_wall_backhand",
  "side_wall_forehand",
  "contrapared_boast",
  "bandeja",
] as const;

test("trainStrokePresetEnum matches app train-taxonomy preset ids", () => {
  const dbIds = [...trainStrokePresetEnum.enumValues].sort();
  const appIds = [...APP_TRAIN_STROKE_PRESET_IDS].sort();
  assert.deepEqual(dbIds, appIds);
});

test("trainStrokePresetEnum accepts serve and return forehand return lob", () => {
  assert.ok(trainStrokePresetEnum.enumValues.includes("forehand_return_with_lob"));
});

test("train category and skill enums are non-empty", () => {
  assert.ok(trainCategoryEnum.enumValues.includes("save_return"));
  assert.ok(trainSkillLevelEnum.enumValues.includes("intermediate"));
});
