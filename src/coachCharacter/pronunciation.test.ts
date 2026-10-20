import assert from "node:assert/strict";
import test from "node:test";
import { applyPronunciation, PRONUNCIATION_LEXICON, type PronunciationEntry } from "./pronunciation";

const LEXICON: PronunciationEntry[] = [
  { term: "Xevo", spoken: { en: "Zee-voh", es: "Ché-vo" } },
  { term: "Axevo", spoken: { en: "Ax-ee-voh" } },
  { term: "AI", spoken: { en: "A I" }, caseSensitive: true },
  { term: "km/h", spoken: { en: "kilometers per hour" } },
];

test("applyPronunciation swaps whole-word terms per locale", () => {
  assert.equal(applyPronunciation("Welcome to Xevo!", "en", LEXICON), "Welcome to Zee-voh!");
  assert.equal(applyPronunciation("Bienvenido a Xevo.", "es", LEXICON), "Bienvenido a Ché-vo.");
});

test("applyPronunciation is case-insensitive unless the entry says otherwise", () => {
  assert.equal(applyPronunciation("xevo and XEVO", "en", LEXICON), "Zee-voh and Zee-voh");
  assert.equal(applyPronunciation("AI said hi, ai", "en", LEXICON), "A I said hi, ai");
});

test("applyPronunciation does not touch terms inside longer words", () => {
  assert.equal(applyPronunciation("Xevos and preXevo", "en", LEXICON), "Xevos and preXevo");
  assert.equal(applyPronunciation("AIM", "en", LEXICON), "AIM");
});

test("applyPronunciation prefers the longest term and leaves unmapped locales alone", () => {
  assert.equal(applyPronunciation("Axevo builds Xevo", "en", LEXICON), "Ax-ee-voh builds Zee-voh");
  assert.equal(applyPronunciation("Axevo", "es", LEXICON), "Axevo");
});

test("applyPronunciation handles terms with punctuation", () => {
  assert.equal(applyPronunciation("Hit it at 90 km/h.", "en", LEXICON), "Hit it at 90 kilometers per hour.");
});

test("the default lexicon reads scores, symbols and category ids", () => {
  assert.equal(applyPronunciation("You scored 82/100 today.", "en"), "You scored 82 out of 100 today.");
  assert.equal(applyPronunciation("Rate it 7/10.", "en"), "Rate it 7 out of 10.");
  assert.equal(applyPronunciation("Bend 45° and hit 80%.", "en"), "Bend 45 degrees and hit 80 percent.");
  assert.equal(applyPronunciation("Work on net_play.", "en"), "Work on net play.");
  assert.equal(applyPronunciation("Trabaja el net_play.", "es"), "Trabaja el juego de red.");
});

test("the default lexicon says the brand the Spanish way", () => {
  assert.equal(applyPronunciation("Bienvenido a Axevo AI.", "es"), "Bienvenido a A equis evo ei ai.");
  assert.equal(applyPronunciation("Bienvenido a AxevoAI.", "es"), "Bienvenido a A equis evo ei ai.");
  assert.equal(applyPronunciation("El equipo de Axevo.", "es"), "El equipo de A equis evo.");
});

test("every default entry has a unique term and at least one spoken form", () => {
  const seen = new Set<string>();
  for (const e of PRONUNCIATION_LEXICON) {
    const key = e.caseSensitive ? e.term : e.term.toLowerCase();
    assert.ok(!seen.has(key), `duplicate term ${e.term}`);
    seen.add(key);
    assert.ok(e.spoken.en || e.spoken.es, `no spoken form for ${e.term}`);
  }
});
