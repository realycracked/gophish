import { test } from "node:test";
import assert from "node:assert/strict";
import { proxify, rewriteCss, proxyPath, realFromProxy } from "../src/index.js";
import { encodeUrl } from "../src/codec.js";

const ORIGIN = "https://proxy.example";
const target = new URL("https://site.com/dir/page.html");

// Adresse proxy (absolue) -> URL réelle.
function real(proxUrl) {
  const u = new URL(proxUrl);
  return realFromProxy(u.pathname, u.search);
}

test("proxyPath garde le vrai chemin derrière l'origine encodée", () => {
  const p = proxyPath("https://www.chess.com/bundles/app/main.js?v=2");
  assert.equal(p, "/w/" + encodeUrl("https://www.chess.com") + "/bundles/app/main.js?v=2");
  assert.equal(realFromProxy(p.split("?")[0], "?v=2"), "https://www.chess.com/bundles/app/main.js?v=2");
});

test("un chemin relatif se résout dans le proxy comme sur le vrai site", () => {
  // Le bug chess.com : un module "./chunk.js" chargé depuis un autre module.
  const moduleUrl = new URL(ORIGIN + proxyPath("https://www.chess.com/bundles/app/vite/glob.js"));
  const chunk = new URL("./rolldown-runtime.js", moduleUrl);
  assert.equal(real(chunk.href), "https://www.chess.com/bundles/app/vite/rolldown-runtime.js");
});

test("realFromProxy accepte encore l'ancien format /p/ et refuse le reste", () => {
  assert.equal(realFromProxy("/p/" + encodeUrl("https://a.com/x?y=1"), ""), "https://a.com/x?y=1");
  assert.equal(realFromProxy("/p/rolldown-runtime.CNC7AqOflz.chunk.js", ""), null);
  assert.equal(realFromProxy("/w/" + encodeUrl("https://a.com/pas-une-origine") + "/x", ""), null);
});

test("proxify résout le relatif contre la page", () => {
  assert.equal(real(proxify("img.png", target, ORIGIN)), "https://site.com/dir/img.png");
  assert.equal(real(proxify("/a/b.js", target, ORIGIN)), "https://site.com/a/b.js");
  assert.equal(real(proxify("//cdn.com/x.js", target, ORIGIN)), "https://cdn.com/x.js");
});

test("proxify garde absolu et query/fragment", () => {
  assert.equal(real(proxify("https://other.net/z?q=1", target, ORIGIN)), "https://other.net/z?q=1");
  assert.ok(proxify("https://other.net/z#ancre", target, ORIGIN).endsWith("/z#ancre"));
});

test("en mode site, les URLs du site deviennent des chemins racine", () => {
  const home = "https://site.com";
  assert.equal(proxify("https://site.com/play?x=1", target, ORIGIN, home), "/play?x=1");
  assert.equal(proxify("img.png", target, ORIGIN, home), "/dir/img.png");
  // Un autre domaine passe toujours par /w/.
  assert.equal(real(proxify("https://cdn.com/a.js", target, ORIGIN, home)), "https://cdn.com/a.js");
});

test("proxify laisse intacts data/js/mailto/ancre", () => {
  for (const v of ["data:image/png;base64,AAA", "javascript:void(0)", "mailto:a@b.com", "#top", "tel:+33", "blob:xyz"]) {
    assert.equal(proxify(v, target, ORIGIN), v);
  }
});

test("rewriteCss réécrit url() et @import", () => {
  const css = ".a{background:url('bg.png')}.b{background:url(/img/x.jpg)}@import \"theme.css\";";
  const out = rewriteCss(css, target, ORIGIN);
  const urls = [...out.matchAll(/(https:\/\/proxy\.example\/w\/[^'")\s;]+)/g)].map((m) => real(m[1]));
  assert.ok(urls.includes("https://site.com/dir/bg.png"));
  assert.ok(urls.includes("https://site.com/img/x.jpg"));
  assert.ok(urls.includes("https://site.com/dir/theme.css"));
});

test("rewriteCss ignore les data: URI", () => {
  const css = ".a{background:url(data:image/svg+xml,<svg/>)}";
  assert.equal(rewriteCss(css, target, ORIGIN), css);
});
