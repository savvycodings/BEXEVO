// Guards that the server's specialty catalog (coachSpecialties.ts) and the app's
// (FEXevo/src/lib/coachSpecialties.ts) list the same keys in the same order, the same way
// gamification/achievementCatalogParity.test.ts guards achievements. The app file is read as text
// from the sibling FEXevo checkout (or FEXEVO_DIR); the test skips when it isn't there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { COACH_SPECIALTY_KEYS } from "./coachSpecialties";

const CLIENT_CATALOG_PATH = path.resolve(
  process.env.FEXEVO_DIR || path.resolve(__dirname, "../../../FEXevo"),
  "src/lib/coachSpecialties.ts"
);

function extractClientKeys(source: string): string[] {
  const block = source.match(/COACH_SPECIALTY_KEYS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

test(
  "server COACH_SPECIALTY_KEYS matches FEXevo's client catalog",
  { skip: !fs.existsSync(CLIENT_CATALOG_PATH) && "FEXevo checkout not found (set FEXEVO_DIR)" },
  () => {
    const clientKeys = extractClientKeys(fs.readFileSync(CLIENT_CATALOG_PATH, "utf8"));
    assert.ok(clientKeys.length > 0, "found no COACH_SPECIALTY_KEYS entries in the client catalog");
    assert.deepEqual(clientKeys, [...COACH_SPECIALTY_KEYS]);
  }
);
