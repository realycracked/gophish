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

// Reddit bloque les IP de datacenter : on sert le contenu via Redlib (frontend
// open-source, fork maintenu de Libreddit), avec plusieurs instances en repli.
const REDDIT_RE = /(^|\.)reddit\.com$/i;
const REDLIB_INSTANCES = [
  "redlib.catsarch.com",
  "safereddit.com",
  "redlib.perennialte.ch",
  "l.opnxng.com",
  "reddit.nerdvpn.de",
];
function isRedlib(host) { return REDLIB_INSTANCES.includes(host); }

// Style "ancien Reddit" (old.reddit) injecté dans les pages Redlib : fond
// gris-bleu clair, panneaux blancs, liens bleus, Verdana compact, bordures
// carrées. Redlib gère son apparence via des variables CSS → on les surcharge.
const REDLIB_STYLE =
  '<style id="vt-redlib">' +
  ':root,body{' +
  '--background:#dae0e6!important;--outside:#ffffff!important;--foreground:#ffffff!important;' +
  '--post:#ffffff!important;--highlighted:#f6f7f8!important;--panel-border:1px solid #cccccc!important;' +
  '--text:#1a1a1b!important;--accent:#0079d3!important;--green:#46a508!important;--visited:#551a8b!important;' +
  '--shadow:0 1px 2px rgba(0,0,0,.08)!important;--nsfw:#ff585b!important;--admin:#ff4500!important;}' +
  'html,body{background:#dae0e6!important;color:#1a1a1b!important;' +
  'font-family:Verdana,Arial,Helvetica,sans-serif!important;font-size:12px!important;line-height:1.4!important;}' +
  'a{color:#0079d3!important;text-decoration:none!important;}' +
  'a:visited{color:#551a8b!important;}a:hover{text-decoration:underline!important;}' +
  '.post,.comment,.panel,.sidebar,.sidebar_label,.search,#search,.post_body,.create,.infobox,.thread,.commentreply{' +
  'border-radius:0!important;box-shadow:none!important;border:1px solid #ccc!important;background:#fff!important;}' +
  '.post:hover{border-color:#898989!important;transform:none!important;}' +
  '.post_score,.score,.comment_score{color:#878a8c!important;font-weight:700!important;}' +
  'h1,h2,.post_title,.post_title a{color:#1a1a1b!important;}' +
  'button,.submit,input[type=submit]{border-radius:2px!important;}' +
  'footer,.footer{opacity:.6!important;}' +
  '</style>';

function redditTargets(target) {
  if (!REDDIT_RE.test(target.hostname)) return [target];
  return REDLIB_INSTANCES.map((host) => {
    const u = new URL(target.href);
    u.protocol = "https:";
    u.hostname = host;
    u.port = "";
    return u;
  });
}

function buildRequestHeaders(request, target) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!STRIP_REQUEST_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("host", target.host);
  const ref = request.headers.get("referer");
  if (ref) {
    try {
      const rp = new URL(ref);
      if (rp.pathname.startsWith("/p/")) headers.set("referer", decodeUrl(rp.pathname.slice(3)));
      else headers.delete("referer");
    } catch (e) { headers.delete("referer"); }
  }
  headers.set("origin", target.origin);
  return headers;
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

  // Cible(s) : pour Reddit, liste d'instances Redlib à essayer dans l'ordre.
  const isGet = request.method === "GET" || request.method === "HEAD";
  const candidates = redditTargets(target);

  let upstream = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (blockedTarget(cand)) continue;
    const init = {
      method: request.method,
      headers: buildRequestHeaders(request, cand),
      redirect: "manual",
      body: isGet ? undefined : request.body,
    };
    // Cache edge pour les ressources statiques (images, JS, CSS, polices…).
    if (isGet && isStatic(cand.pathname)) init.cf = { cacheEverything: true, cacheTtl: 86400 };
    try {
      const r = await fetch(cand.href, init);
      target = cand; // base pour la réécriture et les redirections
      if (r.status < 500 || i === candidates.length - 1) { upstream = r; break; }
      upstream = r; // 5xx : on garde et on tente l'instance suivante
    } catch (e) {
      if (!isGet) break; // corps de requête non rejouable
    }
  }
  if (!upstream) {
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
        if (isRedlib(target.hostname)) el.append(REDLIB_STYLE, { html: true });
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
