import test from "node:test";
import assert from "node:assert/strict";
import { declaredShotConstraints } from "./trainRetrievalHygiene";

test("declaredShotConstraints tries category + preset + skill level first, then relaxes", () => {
  assert.deepEqual(
    declaredShotConstraints({
      category: "net_play",
      strokePreset: "forehand_volley",
      skillLevel: "intermediate",
    }),
    [
      { category: "net_play", strokePreset: "forehand_volley", skillLevel: "intermediate" },
      { category: "net_play", strokePreset: "forehand_volley" },
      { strokePreset: "forehand_volley" },
      { category: "net_play" },
    ]
  );
});

test("declaredShotConstraints drops duplicate and empty steps", () => {
  assert.deepEqual(declaredShotConstraints({ strokePreset: "smash", skillLevel: null }), [
    { category: null, strokePreset: "smash", skillLevel: null },
  ]);
  assert.deepEqual(declaredShotConstraints({ skillLevel: "advanced" }), []);
  assert.deepEqual(declaredShotConstraints(null), []);
});

test("declaredShotConstraints maps the app's display skill label to the enum", () => {
  assert.deepEqual(
    declaredShotConstraints({ category: "overhead", strokePreset: "bandeja", skillLevel: "Advanced" })[0],
    { category: "overhead", strokePreset: "bandeja", skillLevel: "advanced" }
  );
  assert.deepEqual(
    declaredShotConstraints({ category: "overhead", strokePreset: "bandeja", skillLevel: "—" })[0],
    { category: "overhead", strokePreset: "bandeja", skillLevel: null }
  );
});
