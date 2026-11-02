import test from "node:test";
import assert from "node:assert/strict";
import { COUNTRY_REGISTRY, countryByCode, resolveCountry } from "./countryRegistry";

test("resolveCountry matches the part after the last comma", () => {
  assert.equal(resolveCountry("Barcelona, Spain")?.code, "ES");
  assert.equal(resolveCountry("New York, NY, United States")?.code, "US");
});

test("resolveCountry matches name or code ignoring case", () => {
  assert.equal(resolveCountry("es")?.code, "ES");
  assert.equal(resolveCountry("SPAIN")?.code, "ES");
  assert.equal(resolveCountry("  Mexico ")?.name, "Mexico");
});

test("resolveCountry returns null for unknown text", () => {
  assert.equal(resolveCountry("Springfield"), null);
  assert.equal(resolveCountry("Somewhere, Atlantis"), null);
  assert.equal(resolveCountry(""), null);
  assert.equal(resolveCountry(null), null);
});

test("countryByCode ignores case and rejects unknown codes", () => {
  assert.equal(countryByCode("es")?.name, "Spain");
  assert.equal(countryByCode("ZZ"), null);
  assert.equal(countryByCode(undefined), null);
});

test("registry codes and names are unique", () => {
  assert.equal(new Set(COUNTRY_REGISTRY.map((c) => c.code)).size, COUNTRY_REGISTRY.length);
  assert.equal(new Set(COUNTRY_REGISTRY.map((c) => c.name.toLowerCase())).size, COUNTRY_REGISTRY.length);
});
