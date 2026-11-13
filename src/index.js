// Vél-Proxy — Worker Cloudflare
// - sert l'interface statique (via le binding ASSETS)
// - /p/<code> : va chercher une URL, retire les en-têtes qui bloquent l'affichage,
//   réécrit les URLs en flux (HTMLRewriter) et renvoie la réponse en streaming.
// - /__vel/client.js : le script injecté dans les pages proxifiées.

import { encodeUrl, decodeUrl } from "./codec.js";

// En-têtes de réponse à supprimer : ils empêchent l'affichage dans notre contexte.
const STRIP_RESPONSE_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "report-to",
  "nel",
  "permissions-policy",
  "clear-site-data",
];

// En-têtes de requête à ne pas transmettre à la cible.
const STRIP_REQUEST_HEADERS = [
  "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
  "forwarded", "cdn-loop",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Script client : fichier statique servi tel quel (avant le rattrapage Referer).
    if (path === "/vel-client.js") {
      return env.ASSETS.fetch(request);
    }

    if (path === "/p" || path === "/p/") {
      return Response.redirect(url.origin + "/", 302);
    }

    if (path.startsWith("/p/")) {
      return handleProxy(request, url);
    }

    // Rattrape les navigations qui ont quitté /p/ (ex. YouTube qui va vers
    // "/results?...") en les renvoyant vers l'URL réelle proxifiée.
    const rescued = rescueByReferer(request, url);
    if (rescued) return rescued;

    // Tout le reste = fichiers statiques de l'interface.
    return env.ASSETS.fetch(request);
  },
};

// Si une requête arrive hors /p/ mais vient d'une page proxifiée (Referer en /p/),
// on résout le chemin demandé contre le vrai site et on redirige vers /p/<...>.
function rescueByReferer(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const ref = request.headers.get("referer");
  if (!ref) return null;
  let base;
  try {
    const rp = new URL(ref);
    if (rp.origin !== url.origin) return null;
    if (!rp.pathname.startsWith("/p/")) return null;
    base = decodeUrl(rp.pathname.slice(3));
  } catch (e) {
    return null;
  }
  let abs;
  try {
    abs = new URL(url.pathname + url.search + url.hash, base).href;
  } catch (e) {
    return null;
  }
  return Response.redirect(url.origin + "/p/" + encodeUrl(abs), 302);
}

const STATIC_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp3|ogg|wav|json|map)$/i;
function isStatic(pathname) {
  return STATIC_EXT.test(pathname);
}

function blockedTarget(target) {
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  const h = target.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "[::1]" || h === "::1") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  return false;
}

async function handleProxy(request, url) {
  const code = url.pathname.slice(3);
  let target;
  try {
    target = new URL(decodeUrl(code));
  } catch (e) {
    return errorPage("Adresse illisible", "Le lien est corrompu ou incomplet.", 400, url.origin);
  }

  // Reporte la query de l'URL proxy sur la cible (ex. formulaire GET réécrit
  // vers /p/<...> puis ?search_query=... ajouté par le navigateur).
  if (url.search) {
    target.search = target.search ? target.search + "&" + url.search.slice(1) : url.search;
  }

  if (blockedTarget(target)) {
    return errorPage("Adresse refusée", "Cette destination n'est pas autorisée.", 403, url.origin);
  }

  // Construit la requête vers la cible.
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!STRIP_REQUEST_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("host", target.host);
  // Referer / Origin crédibles pour la cible.
  const ref = request.headers.get("referer");
  if (ref) {
    try {
      const rp = new URL(ref);
      if (rp.pathname.startsWith("/p/")) headers.set("referer", decodeUrl(rp.pathname.slice(3)));
    } catch (e) { headers.delete("referer"); }
  }
  headers.set("origin", target.origin);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  };

  // Cache au bord du réseau pour les ressources statiques (images, JS, CSS,
  // polices…) : partagé entre visiteurs, servi instantanément au 2e passage.
  if (request.method === "GET" && isStatic(target.pathname)) {
    init.cf = { cacheEverything: true, cacheTtl: 86400 };
  }

  let upstream;
  try {
    upstream = await fetch(target.href, init);
  } catch (e) {
    return errorPage("Site injoignable", "Impossible de contacter " + target.hostname + ".", 502, url.origin);
  }

  // Redirections : on réécrit Location pour rester dans le proxy.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has("location")) {
    const loc = upstream.headers.get("location");
    let abs;
    try { abs = new URL(loc, target.href).href; } catch (e) { abs = null; }
    const out = new Headers();
    if (abs) out.set("location", url.origin + "/p/" + encodeUrl(abs));
    copySetCookies(upstream, out, url);
    return new Response(null, { status: upstream.status, headers: out });
  }

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const outHeaders = buildResponseHeaders(upstream, url);

  if (ct.includes("text/html")) {
    const rewritten = rewriteHtml(upstream, target, url.origin);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    return new Response(rewritten.body, { status: upstream.status, headers: outHeaders });
  }

  if (ct.includes("text/css")) {
    const css = await upstream.text();
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    return new Response(rewriteCss(css, target, url.origin), { status: upstream.status, headers: outHeaders });
  }

  // Tout le reste (images, vidéos, JS, polices…) : flux direct, rapide.
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

function buildResponseHeaders(upstream, url) {
  const out = new Headers(upstream.headers);
  for (const h of STRIP_RESPONSE_HEADERS) out.delete(h);
  out.delete("set-cookie");
  copySetCookies(upstream, out, url);
  out.set("access-control-allow-origin", "*");
  return out;
}

// Réécrit les cookies pour qu'ils collent à notre domaine (Domain retiré, Path remis à la racine).
function copySetCookies(upstream, out, url) {
  let cookies = [];
  if (typeof upstream.headers.getSetCookie === "function") {
    cookies = upstream.headers.getSetCookie();
  } else {
    const raw = upstream.headers.get("set-cookie");
    if (raw) cookies = [raw];
  }
  for (const c of cookies) {
    const cleaned = c
      .replace(/;\s*domain=[^;]*/gi, "")
      .replace(/;\s*secure/gi, "")
      .replace(/;\s*samesite=[^;]*/gi, "; SameSite=Lax");
    out.append("set-cookie", cleaned);
  }
}

export function proxify(value, target, origin) {
  if (value == null) return value;
  const v = String(value).trim();
  if (!v) return value;
  if (/^(data|blob|javascript|about|mailto|tel|sms|ws|wss):/i.test(v)) return value;
  if (v.charAt(0) === "#") return value;
  let abs;
  try { abs = new URL(v, target.href).href; } catch (e) { return value; }
  return origin + "/p/" + encodeUrl(abs);
}

function proxifySrcset(value, target, origin) {
  try {
    return value.split(",").map((part) => {
      const seg = part.trim();
      if (!seg) return part;
      const sp = seg.split(/\s+/);
      sp[0] = proxify(sp[0], target, origin);
      return sp.join(" ");
    }).join(", ");
  } catch (e) { return value; }
}

export function rewriteCss(css, target, origin) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const p = proxify(u, target, origin);
    return "url(" + q + p + q + ")";
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    return "@import " + q + proxify(u, target, origin) + q;
  });
}

function rewriteHtml(upstream, target, origin) {
  const attrRules = [
    ["[href]", "href"],
    ["[src]", "src"],
    ["[poster]", "poster"],
    ["[data-src]", "data-src"],
    ["[action]", "action"],
    ["[formaction]", "formaction"],
    ["[background]", "background"],
  ];

  let rewriter = new HTMLRewriter();

  for (const [sel, attr] of attrRules) {
    rewriter = rewriter.on(sel, {
      element(el) {
        const val = el.getAttribute(attr);
        if (val != null) el.setAttribute(attr, proxify(val, target, origin));
        if (el.hasAttribute("integrity")) el.removeAttribute("integrity");
      },
    });
  }

  rewriter = rewriter
    .on("[srcset]", {
      element(el) {
        const val = el.getAttribute("srcset");
        if (val != null) el.setAttribute("srcset", proxifySrcset(val, target, origin));
      },
    })
    .on("[style]", {
      element(el) {
        const val = el.getAttribute("style");
        if (val != null) el.setAttribute("style", rewriteCss(val, target, origin));
      },
    })
    .on("base", { element(el) { el.remove(); } })
    .on('meta[http-equiv="Content-Security-Policy" i]', { element(el) { el.remove(); } })
    .on('meta[http-equiv="refresh" i]', {
      element(el) {
        const c = el.getAttribute("content");
        if (c) {
          const rewritten = c.replace(/url\s*=\s*(.+)$/i, (m, u) => "url=" + proxify(u.trim(), target, origin));
          el.setAttribute("content", rewritten);
        }
      },
    })
    .on("head", {
      element(el) {
        const cfg = '<script>window.__VEL={base:' + JSON.stringify(target.href) + "};<\/script>";
        el.prepend(cfg + '<script src="/vel-client.js"><\/script>', { html: true });
      },
    });

  // Réécrit aussi le CSS dans les balises <style>.
  let styleBuf = "";
  rewriter = rewriter.on("style", {
    text(t) {
      styleBuf += t.text;
      if (t.lastInTextNode) {
        t.replace(rewriteCss(styleBuf, target, origin), { html: false });
        styleBuf = "";
      } else {
        t.remove();
      }
    },
  });

  return rewriter.transform(upstream);
}

function errorPage(title, msg, status, origin) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
background:radial-gradient(1000px 500px at 50% -10%,#241a4d,#0b0b14 60%),#0b0b14;color:#eef0ff}
.card{max-width:460px;text-align:center;padding:40px 28px}
.badge{width:56px;height:56px;border-radius:16px;margin:0 auto 20px;
background:conic-gradient(from 210deg,#7c5cff,#38e8ff,#7c5cff);box-shadow:0 0 30px rgba(124,92,255,.6)}
h1{font-size:1.4rem;margin:0 0 8px}p{color:#a7a8c6;margin:0 0 22px;line-height:1.5}
a{display:inline-block;background:linear-gradient(135deg,#7c5cff,#38a8ff);color:#fff;text-decoration:none;
font-weight:600;padding:11px 22px;border-radius:11px}
</style></head><body><div class="card"><div class="badge"></div>
<h1>${title}</h1><p>${msg}</p><a href="${origin}/">Retour à l'accueil</a></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
