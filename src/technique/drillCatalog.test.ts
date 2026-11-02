import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DRILLS, localizeDrill, parseFocus, rankDrills, shotTags } from "./drillCatalog";

test("shotTags reads English and Spanish shot labels", () => {
  assert.deepEqual(shotTags("Forehand volley"), ["volley", "forehand"]);
  assert.deepEqual(shotTags("Volea de revés"), ["volley", "backhand"]);
  assert.deepEqual(shotTags(null), []);
});

test("parseFocus keeps order, drops unknown and duplicate ids", () => {
  assert.deepEqual(parseFocus("racket, elbow,knee,racket"), ["racket", "elbow"]);
  assert.deepEqual(parseFocus(undefined), []);
});

test("rankDrills favours the first focus and the shot", () => {
  const top = rankDrills(DEFAULT_DRILLS, ["elbow", "racket"], "Forehand volley", 3).map((d) => d.slug);
  // split-step-volley and controlled-feed tie (3); catalogue order breaks it.
  assert.deepEqual(top, ["shadow-volley", "split-step-volley", "controlled-feed"]);
});

test("rankDrills pushes drills written for other shots down", () => {
  const top = rankDrills(DEFAULT_DRILLS, ["torso"], "Bandeja", 2).map((d) => d.slug);
  assert.deepEqual(top, ["bandeja-shadow", "medicine-ball-turns"]);
});

test("every default drill has English and Spanish copy with steps", () => {
  const slugs = new Set<string>();
  for (const d of DEFAULT_DRILLS) {
    assert.ok(!slugs.has(d.slug), d.slug);
    slugs.add(d.slug);
    for (const lang of ["en", "es"] as const) {
      const out = localizeDrill(d, lang);
      assert.ok(out.title && out.summary && out.focusLabel, `${d.slug} ${lang}`);
      assert.ok(out.steps.length >= 3, `${d.slug} ${lang} steps`);
    }
  }
});
