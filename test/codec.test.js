import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeUrl, decodeUrl } from "../src/codec.js";

const CASES = [
  "https://www.youtube.com/",
  "https://example.com/path?a=1&b=2#frag",
  "https://café.fr/menu?plat=crêpe&prix=3€",
  "https://site.com/" + "x".repeat(2000),
  "https://a.b/αβγ/日本語/emoji😀",
];

test("round-trip encode/decode", () => {
  for (const url of CASES) {
    assert.equal(decodeUrl(encodeUrl(url)), url);
  }
});

test("produit un segment URL-safe (pas de / + = espace)", () => {
  for (const url of CASES) {
    const code = encodeUrl(url);
    assert.ok(!/[/+=\s]/.test(code), "code non URL-safe: " + code.slice(0, 40));
  }
});

// Vérifie que l'encodeur du navigateur (btoa/TextEncoder) donne le même résultat
// que celui du serveur — même algorithme, donc doit matcher à l'octet près.
test("encodeur client identique au serveur", () => {
  function clientEnc(url) {
    const bytes = new TextEncoder().encode(url);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  for (const url of CASES) {
    assert.equal(clientEnc(url), encodeUrl(url));
  }
});
