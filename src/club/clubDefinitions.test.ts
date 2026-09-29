import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidClubAmenityKey,
  isValidClubCourtIndoorOutdoor,
  slugifyClubName,
} from "./clubDefinitions";

test("slugifyClubName lowercases, strips accents/punctuation, and hyphenates", () => {
  assert.equal(slugifyClubName("i95 Padel Club!"), "i95-padel-club");
  assert.equal(slugifyClubName("Reserve Padel"), "reserve-padel");
  assert.equal(slugifyClubName("Cancha  Núñez — Miami"), "cancha-nunez-miami");
  assert.equal(slugifyClubName("  leading/trailing  "), "leading-trailing");
});

test("slugifyClubName never returns leading/trailing hyphens", () => {
  assert.equal(slugifyClubName("---!!!---"), "");
});

test("isValidClubAmenityKey only accepts the fixed catalog", () => {
  assert.equal(isValidClubAmenityKey("parking"), true);
  assert.equal(isValidClubAmenityKey("showers"), true);
  assert.equal(isValidClubAmenityKey("free_text_amenity"), false);
  assert.equal(isValidClubAmenityKey(""), false);
});

test("isValidClubCourtIndoorOutdoor only accepts indoor/outdoor/covered", () => {
  assert.equal(isValidClubCourtIndoorOutdoor("indoor"), true);
  assert.equal(isValidClubCourtIndoorOutdoor("outdoor"), true);
  assert.equal(isValidClubCourtIndoorOutdoor("covered"), true);
  assert.equal(isValidClubCourtIndoorOutdoor("underwater"), false);
});
