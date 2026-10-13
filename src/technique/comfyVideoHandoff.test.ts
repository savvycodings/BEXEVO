import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { applyControlHandoff, funControlEndStep } from "./comfyVideo";
import { renderOpenPoseMp4, softControlLandmarks, type NamedLandmarks } from "./openPoseVideo";

type Workflow = Record<string, { class_type?: string; inputs?: Record<string, any> }>;

function loadWorkflow(): Workflow {
  const file = path.join(__dirname, "../../workflows/video_wan2_2_fun_control.runpod_bf16.api.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
}

test("funControlEndStep never hands off before the high/low expert switch", () => {
  assert.equal(funControlEndStep(20, 10, 1), 20);
  assert.equal(funControlEndStep(20, 10, 0.7), 14);
  assert.equal(funControlEndStep(20, 10, 0.5), 10);
  assert.equal(funControlEndStep(20, 10, 0.2), 10);
  assert.equal(funControlEndStep(20, 10, 3), 20);
});

test("applyControlHandoff leaves the workflow untouched when the skeleton runs every step", () => {
  const wf = loadWorkflow();
  const before = JSON.stringify(wf);
  applyControlHandoff(wf, { steps: 20, controlEndStep: 20, tail: "soft", softVideoName: "soft.mp4" });
  assert.equal(JSON.stringify(wf), before);
});

test("applyControlHandoff splits the low pass and gives the tail the soft skeleton", () => {
  const wf = loadWorkflow();
  applyControlHandoff(wf, { steps: 20, controlEndStep: 14, tail: "soft", softVideoName: "soft.mp4" });

  assert.equal(wf["96"].inputs!.start_at_step, 0);
  assert.equal(wf["96"].inputs!.end_at_step, 10);
  assert.equal(wf["95"].inputs!.start_at_step, 10);
  assert.equal(wf["95"].inputs!.end_at_step, 14);
  assert.equal(wf["95"].inputs!.return_with_leftover_noise, "enable");
  assert.deepEqual(wf["95"].inputs!.positive, ["160", 0]);

  const tail = wf["164"].inputs!;
  assert.equal(wf["164"].class_type, "KSamplerAdvanced");
  assert.equal(tail.start_at_step, 14);
  assert.equal(tail.end_at_step, 20);
  assert.equal(tail.add_noise, "disable");
  assert.equal(tail.return_with_leftover_noise, "disable");
  assert.deepEqual(tail.model, ["94", 0]);
  assert.deepEqual(tail.latent_image, ["95", 0]);
  assert.deepEqual(tail.positive, ["161", 0]);
  assert.deepEqual(tail.negative, ["161", 1]);

  const tailControl = wf["161"].inputs!;
  assert.equal(wf["161"].class_type, "Wan22FunControlToVideo");
  assert.deepEqual(tailControl.ref_image, ["145", 0]);
  assert.deepEqual(tailControl.positive, ["99", 0]);
  assert.deepEqual(tailControl.control_video, ["163", 0]);
  assert.equal(wf["162"].inputs!.file, "soft.mp4");
  assert.deepEqual(wf["163"].inputs!.video, ["162", 0]);
  assert.deepEqual(wf["160"].inputs!.control_video, ["156", 0]);

  assert.deepEqual(wf["97"].inputs!.samples, ["164", 0]);
});

test("applyControlHandoff with no tail control omits the control video instead of drawing black", () => {
  const wf = loadWorkflow();
  applyControlHandoff(wf, { steps: 20, controlEndStep: 10, tail: "none" });
  assert.equal("control_video" in wf["161"].inputs!, false);
  assert.deepEqual(wf["161"].inputs!.ref_image, ["145", 0]);
  assert.equal(wf["162"], undefined);
  assert.equal(wf["95"].inputs!.end_at_step, 10);
  assert.equal(wf["164"].inputs!.start_at_step, 10);
  assert.deepEqual(wf["97"].inputs!.samples, ["164", 0]);
});

test("softControlLandmarks drops hand points and keeps body and feet", () => {
  const p = { x: 0.5, y: 0.5, visibility: 1 };
  const frame: NamedLandmarks = {
    LEFT_WRIST: p,
    RIGHT_WRIST: p,
    LEFT_INDEX: p,
    RIGHT_PINKY: p,
    RIGHT_THUMB: p,
    RIGHT_HAND_0: p,
    LEFT_HAND_12: p,
    LEFT_FOOT_INDEX: p,
    RIGHT_ANKLE: p,
  };
  const [soft] = softControlLandmarks([frame]);
  assert.deepEqual(Object.keys(soft).sort(), ["LEFT_FOOT_INDEX", "LEFT_WRIST", "RIGHT_ANKLE", "RIGHT_WRIST"]);
});

test("renderOpenPoseMp4 renders a blurred clip", async () => {
  const lm: NamedLandmarks = {
    LEFT_SHOULDER: { x: 0.4, y: 0.3 },
    RIGHT_SHOULDER: { x: 0.6, y: 0.3 },
    LEFT_HIP: { x: 0.42, y: 0.6 },
    RIGHT_HIP: { x: 0.58, y: 0.6 },
  };
  const buf = await renderOpenPoseMp4({ landmarkFrames: [lm, lm, lm], width: 64, height: 64, fps: 16, blurSigma: 2.5 });
  assert.ok(buf.length > 0);
});
