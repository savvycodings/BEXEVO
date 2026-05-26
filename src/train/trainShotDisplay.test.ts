import test from "node:test";
import assert from "node:assert/strict";
import { adminStrokeLabelKey } from "./trainShotDisplay";

test("adminStrokeLabelKey prefers strokeLabel column", () => {
  assert.equal(
    adminStrokeLabelKey("Drop Shot forehand", "Contrapared boast · Advanced"),
    "Drop Shot forehand"
  );
});

test("adminStrokeLabelKey strips level from strokeName when label missing", () => {
  assert.equal(
    adminStrokeLabelKey(null, "Forehand Half Volley · Advanced"),
    "Forehand Half Volley"
  );
});
