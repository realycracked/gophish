import { test } from "node:test";
import assert from "node:assert/strict";
import { proxify, rewriteCss } from "../src/index.js";
import { decodeUrl } from "../src/codec.js";

const ORIGIN = "https://proxy.example";
const target = new URL("https://site.com/dir/page.html");

// Décode un /p/<code> en l'URL réelle, pour vérifier la cible.
function decoded(proxUrl) {
  const code = proxUrl.replace(ORIGIN + "/p/", "");
  return decodeUrl(code);
}

test("proxify résout le relatif contre la page", () => {
  assert.equal(decoded(proxify("img.png", target, ORIGIN)), "https://site.com/dir/img.png");
  assert.equal(decoded(proxify("/a/b.js", target, ORIGIN)), "https://site.com/a/b.js");
  assert.equal(decoded(proxify("//cdn.com/x.js", target, ORIGIN)), "https://cdn.com/x.js");
});

test("proxify garde absolu et query/fragment", () => {
  assert.equal(decoded(proxify("https://other.net/z?q=1", target, ORIGIN)), "https://other.net/z?q=1");
});

test("proxify laisse intacts data/js/mailto/ancre", () => {
  for (const v of ["data:image/png;base64,AAA", "javascript:void(0)", "mailto:a@b.com", "#top", "tel:+33", "blob:xyz"]) {
    assert.equal(proxify(v, target, ORIGIN), v);
  }
});

test("rewriteCss réécrit url() et @import", () => {
  const css = ".a{background:url('bg.png')}.b{background:url(/img/x.jpg)}@import \"theme.css\";";
  const out = rewriteCss(css, target, ORIGIN);
  assert.ok(out.includes(ORIGIN + "/p/"), "doit contenir des URLs proxifiées");
  const urls = [...out.matchAll(/\/p\/([A-Za-z0-9_-]+)/g)].map((m) => decodeUrl(m[1]));
  assert.ok(urls.includes("https://site.com/dir/bg.png"));
  assert.ok(urls.includes("https://site.com/img/x.jpg"));
  assert.ok(urls.includes("https://site.com/dir/theme.css"));
});

test("rewriteCss ignore les data: URI", () => {
  const css = ".a{background:url(data:image/svg+xml,<svg/>)}";
  assert.equal(rewriteCss(css, target, ORIGIN), css);
});
