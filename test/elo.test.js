import { test } from "node:test";
import assert from "node:assert/strict";
import { eloUpdate, cleanName } from "../src/chess.js";

test("Elo : à niveau égal, une victoire rapporte 20 points (K=40)", () => {
  assert.deepEqual(eloUpdate(1200, 1200, 1, 0, 0), [1220, 1180]);
  assert.deepEqual(eloUpdate(1200, 1200, 0.5, 0, 0), [1200, 1200]);
});

test("Elo : battre plus fort rapporte plus, K=20 après 30 parties", () => {
  const [a] = eloUpdate(1200, 1600, 1, 50, 50);
  assert.ok(a - 1200 > 15 && a - 1200 <= 20);
  const [, b] = eloUpdate(1200, 1600, 1, 50, 50);
  assert.ok(1600 - b > 15);
});

test("pseudo nettoyé", () => {
  assert.equal(cleanName("  Magnus  C. "), "Magnus C.");
  assert.equal(cleanName("<b>x</b>"), "bxb");
  assert.equal(cleanName("a"), null);
  assert.equal(cleanName("abcdefghijklmnopqrstu").length, 16);
});
