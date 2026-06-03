import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachReviewReadyEmail } from "./templates/coachReviewReady";

test("buildCoachReviewReadyEmail includes feedback preview and CTA", () => {
  const { subject, html, text } = buildCoachReviewReadyEmail({
    studentName: "Alex",
    coachFeedbackPreview: "Keep your racket head up through contact.",
    annotationCount: 3,
    openUrl: "https://bexevo-production.up.railway.app/",
  });

  assert.equal(subject, "Your coach feedback is ready");
  assert.match(text, /Alex/);
  assert.match(text, /Keep your racket head up/);
  assert.match(text, /3 annotated frames/);
  assert.match(html, /View coach review/);
  assert.match(html, /Keep your racket head up through contact/);
});

test("buildCoachReviewReadyEmail falls back when preview is missing", () => {
  const { text } = buildCoachReviewReadyEmail({
    studentName: "",
    coachFeedbackPreview: null,
    annotationCount: 0,
    openUrl: null,
  });

  assert.match(text, /Open the Xevo app/);
});
