// Point d'entrée "fichier unique" : le Worker sert aussi les pages (HTML/CSS/JS)
// embarquées, sans binding ASSETS. Sert à déployer en collant un seul fichier
// dans l'éditeur Cloudflare ("Edit code"). Généré par scripts/build-single.mjs.
import worker from "./index.js";
import { ASSETS_MAP } from "./assets.generated.js";

const inlineAssets = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = url.pathname;
    if (p === "/") p = "/index.html";
    if (!ASSETS_MAP[p] && ASSETS_MAP[p + ".html"]) p = p + ".html";
    const a = ASSETS_MAP[p];
    if (!a) return new Response("Introuvable", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(a.body, {
      headers: { "content-type": a.type, "cache-control": "public, max-age=300" },
    });
  },
};

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, { ...env, ASSETS: inlineAssets }, ctx);
  },
};
