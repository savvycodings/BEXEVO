// Guards that the server's country list (countryRegistry.ts) and the app's picker list
// (FEXevo/src/lib/countries.ts COUNTRIES_DATA) have the same codes and names, the same way
// gamification/achievementCatalogParity.test.ts guards achievements. The app file is read as text
// (it `require`s flag PNGs) from the sibling FEXevo checkout (or FEXEVO_DIR); the test skips when
// it isn't there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { COUNTRY_REGISTRY } from "./countryRegistry";

const CLIENT_COUNTRIES_PATH = path.resolve(
  process.env.FEXEVO_DIR || path.resolve(__dirname, "../../../FEXevo"),
  "src/lib/countries.ts"
);

function extractClientCountries(source: string): Array<{ code: string; name: string }> {
  return [...source.matchAll(/\{\s*code:\s*'([^']+)',\s*name:\s*'([^']*)'/g)].map((m) => ({
    code: m[1],
    name: m[2],
  }));
}

test(
  "server COUNTRY_REGISTRY matches FEXevo's countries.ts",
  { skip: !fs.existsSync(CLIENT_COUNTRIES_PATH) && "FEXevo checkout not found (set FEXEVO_DIR)" },
  () => {
    const client = extractClientCountries(fs.readFileSync(CLIENT_COUNTRIES_PATH, "utf8"));
    assert.ok(client.length > 0, "found no country rows in the client file");
    const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
    assert.deepEqual([...COUNTRY_REGISTRY].sort(byCode), [...client].sort(byCode));
  }
);
