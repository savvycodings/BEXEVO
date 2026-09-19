// Guards the thing that actually breaks achievements silently: the server's ACHIEVEMENT_KEYS
// (definitions.ts, what meetsAchievement in achievements.ts switches on) drifting out of sync
// with the client's ACHIEVEMENTS catalog (FEXevo/src/lib/achievementsCatalog.ts, what the app
// renders and lets a user claim). A key present on one side and not the other means either a
// badge the app can never earn, or a server unlock the app can never display/claim.
//
// FEXevo is a sibling repo, not an importable package from here, so this reads its catalog file
// as text from the conventional local sibling checkout path and regex-extracts `key: '...'`
// entries rather than executing it (the file does `require(...png)` at module scope, which only
// resolves under Metro/Expo). If that sibling checkout isn't present (e.g. a CI runner that only
// checks out BEXevo), the test skips instead of failing — this is a local dev safety net, not a
// substitute for keeping both files hand-in-sync during review.

// `./definitions` transitively imports `../db` (via `./stats`), which throws at module load if
// DATABASE_URL isn't set — load it the same way the server's own entrypoint does.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { ACHIEVEMENT_KEYS } from "./definitions";

const CLIENT_CATALOG_PATH = path.resolve(
  __dirname,
  "../../../FEXevo/src/lib/achievementsCatalog.ts"
);

function extractClientKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /key:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) keys.push(m[1]);
  return keys;
}

test(
  "server ACHIEVEMENT_KEYS matches FEXevo's client achievementsCatalog",
  { skip: !fs.existsSync(CLIENT_CATALOG_PATH) && "FEXevo sibling checkout not found locally" },
  () => {
    const source = fs.readFileSync(CLIENT_CATALOG_PATH, "utf8");
    const clientKeys = extractClientKeys(source);
    assert.ok(clientKeys.length > 0, "found no `key: '...'` entries in the client catalog");

    const serverSet = new Set<string>(ACHIEVEMENT_KEYS);
    const clientSet = new Set(clientKeys);

    const missingFromClient = ACHIEVEMENT_KEYS.filter((k) => !clientSet.has(k));
    const missingFromServer = clientKeys.filter((k) => !serverSet.has(k));

    assert.equal(
      missingFromClient.length,
      0,
      `server-only achievement keys the app can never display/claim: ${missingFromClient.join(", ")}`
    );
    assert.equal(
      missingFromServer.length,
      0,
      `client-only achievement keys the server can never unlock: ${missingFromServer.join(", ")}`
    );
  }
);
