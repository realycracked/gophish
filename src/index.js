// Vél·Tube — Worker Cloudflare (proxy + application)
//
// Formes d'URL :
//   /__vt/...            l'application (fichiers statiques) ; "/" et "/youtube" y mènent
//   /w/<origine>/<chemin> page ou ressource d'un site, en gardant son vrai chemin
//   /p/<url complète>     ancien format (une seule pièce), toujours accepté
//   /<chemin>             "mode site" : le site ouvert en dernier (cookie __vt_site)
//                         est servi à la racine avec ses vrais chemins, pour que ses
//                         routes, ses chemins relatifs et ses modules JS marchent.

import { chessRoute } from "./chess.js";
import { searchApi } from "./search.js";
export { ChessRoom, ChessLobby } from "./chess.js";
import { encodeUrl, decodeUrl } from "./codec.js";

const SITE_COOKIE = "__vt_site";
const APP = "/__vt/";

// En-têtes de réponse qui empêchent l'affichage ou cassent le proxy.
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
  "referrer-policy",
  "link", // préchargements (preload) vers les vraies adresses, hors proxy
];

// En-têtes de requête à ne pas transmettre à la cible.
const STRIP_REQUEST_HEADERS = [
  "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip",
  "forwarded", "cdn-loop",
];

// ---------------------------------------------------------------- URL ----

// /w/<origine encodée>/<chemin>?<requête>#<ancre>
export function proxyPath(abs) {
  const u = new URL(abs);
  return "/w/" + encodeUrl(u.origin) + u.pathname + u.search + u.hash;
}

// URL réelle derrière un chemin /w/... ou /p/..., ou null.
export function realFromProxy(pathname, search) {
  if (pathname.startsWith("/w/")) {
    const rest = pathname.slice(3);
    const i = rest.indexOf("/");
    const code = i < 0 ? rest : rest.slice(0, i);
    const path = i < 0 ? "/" : rest.slice(i);
    let origin;
    try { origin = decodeUrl(code); } catch (e) { return null; }
    if (!/^https?:\/\/[^/?#\s]+$/i.test(origin)) return null;
    try { return new URL(origin + path + (search || "")).href; } catch (e) { return null; }
  }
  if (pathname.startsWith("/p/")) {
    let full;
    try { full = decodeUrl(pathname.slice(3)); } catch (e) { return null; }
    if (!/^https?:\/\//i.test(full)) return null;
    let u;
    try { u = new URL(full); } catch (e) { return null; }
    if (search) u.search = u.search ? u.search + "&" + search.slice(1) : search;
    return u.href;
  }
  return null;
}

function withoutVts(search) {
  if (!search || search.indexOf("__vts") < 0) return search || "";
  const p = new URLSearchParams(search);
  p.delete("__vts");
  const s = p.toString();
  return s ? "?" + s : "";
}

function getCookie(request, name) {
  const all = request.headers.get("cookie") || "";
  const m = all.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? m[1] : null;
}

// Origine du site en "mode site" (cookie), ou null.
function siteFromCookie(request) {
  const v = getCookie(request, SITE_COOKIE);
  if (!v) return null;
  try {
    const o = decodeUrl(v);
    return /^https?:\/\/[^/?#\s]+$/i.test(o) ? o : null;
  } catch (e) { return null; }
}

// URL réelle de la page qui a fait la requête (d'après le Referer), ou null.
function refererReal(request, url, site) {
  const ref = request.headers.get("referer");
  if (!ref) return null;
  let rp;
  try { rp = new URL(ref); } catch (e) { return null; }
  if (rp.origin !== url.origin) return null;
  if (rp.pathname.startsWith("/w/") || rp.pathname.startsWith("/p/")) return realFromProxy(rp.pathname, rp.search);
  if (rp.pathname.startsWith(APP) || rp.pathname === "/youtube") return null; // nos pages
  if (site) {
    try { return new URL(site + rp.pathname + withoutVts(rp.search)).href; } catch (e) { return null; }
  }
  return null;
}

function isTopNavigation(request) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return request.method === "GET" && (request.headers.get("accept") || "").includes("text/html");
}

// ------------------------------------------------------------ routage ----

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const site = siteFromCookie(request);

    // Un site ne doit jamais installer de service worker sur notre domaine :
    // il intercepterait l'application et tous les autres sites.
    if (request.headers.get("service-worker") === "script") {
      return new Response("Service workers désactivés par le proxy.", { status: 403 });
    }

    // Échecs en ligne (WebSocket direct vers la partie, sans proxy).
    if (path === APP + "chess/ws" || path === APP + "chess/lobby") return chessRoute(request, url, env);

    // Recherche maison (résultats Bing + images + fiche Wikipédia).
    if (path === APP + "api/search") return searchApi(url);

    // Logo d'un site pour l'écran d'accueil.
    if (path === APP + "icon") return siteIcon(url);

    // Fichiers de l'application : jamais détournés vers un site.
    if (path.startsWith(APP)) return env.ASSETS.fetch(request);

    if (/^\/(w|p)\/?$/.test(path)) return Response.redirect(url.origin + APP, 302);

    if (path.startsWith("/w/") || path.startsWith("/p/")) {
      const real = realFromProxy(path, url.search);
      if (!real) {
        // Chemin relatif collé derrière /p/ ou /w/ par le navigateur (ex. un
        // module "./chunk.js") : on le résout par rapport à la page d'origine.
        const base = refererReal(request, url, site);
        if (base) {
          try { return redirect(request, url.origin + proxyPath(new URL(path.slice(3) + url.search, base).href)); } catch (e) {}
        }
        return errorPage("Adresse illisible", "Le lien est corrompu ou incomplet.", 400, url.origin);
      }
      const target = new URL(real);
      // /w/<notre propre adresse>/... : on revient simplement sur ce chemin.
      if (target.host === url.host) return redirect(request, url.origin + target.pathname + target.search);
      if (request.method === "GET" && isTopNavigation(request) && !isUpgrade(request)) {
        return enterSite(url, target);
      }
      return handleProxy(request, url, target, env, null);
    }

    // "/" et "/youtube" : nos pages, sauf quand la requête vient du site ouvert
    // (lien "accueil" du site) ou porte le marqueur __vts.
    if (path === "/" || path === "/youtube") {
      const fromSite = site && (url.searchParams.has("__vts") || refererReal(request, url, site));
      if (!fromSite) {
        return env.ASSETS.fetch(new Request(new URL(path === "/" ? APP : APP + "youtube", url), request));
      }
    }

    // Chemin racine demandé par une page /w/ (iframe d'un autre domaine…) :
    // il appartient à ce domaine-là.
    const ref = request.headers.get("referer");
    if (ref) {
      try {
        const rp = new URL(ref);
        if (rp.origin === url.origin && (rp.pathname.startsWith("/w/") || rp.pathname.startsWith("/p/"))) {
          const base = realFromProxy(rp.pathname, rp.search);
          if (base && (!site || new URL(base).origin !== site)) {
            return redirect(request, url.origin + proxyPath(new URL(path + url.search, base).href));
          }
        }
      } catch (e) {}
    }

    // Mode site : le chemin appartient au site ouvert.
    if (site) {
      const target = new URL(site + path + withoutVts(url.search));
      return handleProxy(request, url, target, env, site);
    }

    return env.ASSETS.fetch(request);
  },
};

function isUpgrade(request) {
  return (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
}

// 302 pour GET/HEAD ; 307 sinon pour garder la méthode et le corps.
function redirect(request, location) {
  const s = request.method === "GET" || request.method === "HEAD" ? 302 : 307;
  return new Response(null, { status: s, headers: { location } });
}

// Ouvre un site en "mode site" : on retient son origine et on sert la page à
// la racine avec son vrai chemin.
function enterSite(url, target) {
  let loc = target.pathname + target.search;
  if (target.pathname === "/" || target.pathname === "/youtube") {
    loc = target.pathname + (target.search ? target.search + "&" : "?") + "__vts=1";
  }
  const h = new Headers({ location: url.origin + loc + target.hash });
  h.append("set-cookie", SITE_COOKIE + "=" + encodeUrl(target.origin) + "; Path=/; Secure; HttpOnly; SameSite=Lax");
  return new Response(null, { status: 302, headers: h });
}

// ------------------------------------------------------------- proxy ----

const STATIC_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp3|ogg|wav|json|map)$/i;
function isStatic(pathname) {
  return STATIC_EXT.test(pathname);
}

// Logo d'un site (/__vt/icon?u=https://site.com) : service de favicons de Google
// en 128 px, sinon celui de DuckDuckGo. 404 si aucun : l'accueil affiche alors
// une lettre. Mis en cache une semaine au bord du réseau.
async function siteIcon(url) {
  let site;
  try {
    site = new URL(url.searchParams.get("u") || "");
    if (!/^https?:$/.test(site.protocol)) throw new Error();
  } catch {
    return new Response("", { status: 400 });
  }
  const sources = [
    "https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=" +
      encodeURIComponent(site.origin),
    "https://icons.duckduckgo.com/ip3/" + site.hostname + ".ico",
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src, { cf: { cacheEverything: true, cacheTtl: 604800 } });
      const type = r.headers.get("content-type") || "";
      if (r.ok && type.startsWith("image/")) {
        return new Response(r.body, {
          headers: { "content-type": type, "cache-control": "public, max-age=604800" },
        });
      }
    } catch {}
  }
  return new Response("", { status: 404, headers: { "cache-control": "public, max-age=3600" } });
}

function blockedTarget(target, env) {
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  if (env && env.ALLOW_LOCAL === "1") return false; // tests locaux uniquement
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

function buildRequestHeaders(request, target, url, site) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!STRIP_REQUEST_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("host", target.host);
  // Cookies : on retire le nôtre et on rend leur nom aux cookies "__Host-".
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const kept = cookie.split(/;\s*/).filter((c) => c && !c.startsWith(SITE_COOKIE + "="))
      .map((c) => c.replace(/^vtH-/, "__Host-"));
    if (kept.length) headers.set("cookie", kept.join("; ")); else headers.delete("cookie");
  }
  const realRef = refererReal(request, url, site);
  if (realRef) headers.set("referer", realRef); else headers.delete("referer");
  if (request.headers.has("origin")) headers.set("origin", target.origin);
  return headers;
}

async function handleProxy(request, url, target, env, site) {
  if (blockedTarget(target, env)) {
    return errorPage("Adresse refusée", "Cette destination n'est pas autorisée.", 403, url.origin);
  }
  target.search = withoutVts(target.search);

  // WebSocket : on transmet la demande de connexion et on renvoie la réponse
  // du site telle quelle (Cloudflare relaie ensuite les messages).
  if (isUpgrade(request)) {
    try {
      return await fetch(target.href, { headers: buildRequestHeaders(request, target, url, site) });
    } catch (e) {
      return new Response("WebSocket injoignable", { status: 502 });
    }
  }

  // Cible(s) : pour Reddit, liste d'instances Redlib à essayer dans l'ordre.
  const isGet = request.method === "GET" || request.method === "HEAD";
  const candidates = redditTargets(target);

  let upstream = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (blockedTarget(cand, env)) continue;
    const init = {
      method: request.method,
      headers: buildRequestHeaders(request, cand, url, site),
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

  // En mode site, l'origine "maison" est celle réellement servie (Redlib pour Reddit).
  const home = site ? target.origin : null;
  const scope = home ? null : "/w/" + encodeUrl(target.origin);

  // Redirections : on réécrit Location pour rester dans le proxy.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has("location")) {
    const out = new Headers();
    const loc = proxify(upstream.headers.get("location"), target, url.origin, home);
    if (loc) out.set("location", loc);
    copySetCookies(upstream, out, scope);
    return new Response(null, { status: upstream.status, headers: out });
  }

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const outHeaders = buildResponseHeaders(upstream, scope);

  if (ct.includes("text/html")) {
    const rewritten = rewriteHtml(upstream, target, url.origin, home);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    return new Response(rewritten.body, { status: upstream.status, headers: outHeaders });
  }

  if (ct.includes("text/css")) {
    const css = await upstream.text();
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    return new Response(rewriteCss(css, target, url.origin, home), { status: upstream.status, headers: outHeaders });
  }

  // Tout le reste (images, vidéos, JS, polices…) : flux direct, rapide.
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

function buildResponseHeaders(upstream, scope) {
  const out = new Headers(upstream.headers);
  for (const h of STRIP_RESPONSE_HEADERS) out.delete(h);
  out.delete("set-cookie");
  copySetCookies(upstream, out, scope);
  out.set("access-control-allow-origin", "*");
  return out;
}

// Cookies du site : sans Domain (ils doivent coller à notre domaine). En mode
// /w/, leur chemin est rangé sous /w/<origine>/ pour isoler chaque site.
// Les cookies "__Host-" exigent Path=/ : on les renomme "vtH-" (et inversement
// à l'envoi).
function copySetCookies(upstream, out, scope) {
  let cookies = [];
  if (typeof upstream.headers.getSetCookie === "function") {
    cookies = upstream.headers.getSetCookie();
  } else {
    const raw = upstream.headers.get("set-cookie");
    if (raw) cookies = [raw];
  }
  for (const c of cookies) {
    let v = c.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*partitioned/gi, "")
      .replace(/;\s*samesite=[^;]*/gi, "; SameSite=Lax");
    if (/^\s*__Host-/i.test(v)) v = v.replace(/^\s*__Host-/i, "vtH-");
    if (!/;\s*secure/i.test(v)) v += "; Secure";
    if (scope) {
      if (/;\s*path=/i.test(v)) v = v.replace(/;\s*path=([^;]*)/i, (m, p) => "; Path=" + scope + (p.trim().startsWith("/") ? p.trim() : "/" + p.trim()));
      else v += "; Path=" + scope + "/";
    }
    out.append("set-cookie", v);
  }
}

// Réécrit une URL trouvée dans une page. "home" = origine servie en mode site :
// ses URLs deviennent des chemins racine ; les autres passent par /w/.
export function proxify(value, target, origin, home) {
  if (value == null) return value;
  const v = String(value).trim();
  if (!v) return value;
  if (/^(data|blob|javascript|about|mailto|tel|sms|ws|wss):/i.test(v)) return value;
  if (v.charAt(0) === "#") return value;
  let abs;
  try { abs = new URL(v, target.href); } catch (e) { return value; }
  if (abs.protocol !== "http:" && abs.protocol !== "https:") return value;
  if (home && abs.origin === home) return abs.pathname + abs.search + abs.hash;
  // Déjà une adresse du proxy (ex. un anti-robot qui renvoie vers location.href) :
  // on la garde telle quelle, sinon le proxy se proxifierait lui-même.
  if (abs.origin === origin) return abs.pathname + abs.search + abs.hash;
  return origin + proxyPath(abs.href);
}

function proxifySrcset(value, target, origin, home) {
  try {
    return value.split(",").map((part) => {
      const seg = part.trim();
      if (!seg) return part;
      const sp = seg.split(/\s+/);
      sp[0] = proxify(sp[0], target, origin, home);
      return sp.join(" ");
    }).join(", ");
  } catch (e) { return value; }
}

export function rewriteCss(css, target, origin, home) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    return "url(" + q + proxify(u, target, origin, home) + q + ")";
  }).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    return "@import " + q + proxify(u, target, origin, home) + q;
  });
}

function rewriteHtml(upstream, target, origin, home) {
  const attrRules = [
    ["[href]", "href"],
    ["[src]", "src"],
    ["[poster]", "poster"],
    ["[data-src]", "data-src"],
    ["[action]", "action"],
    ["[formaction]", "formaction"],
    ["[background]", "background"],
  ];

  // Script client injecté une seule fois, le plus tôt possible.
  let injected = false;
  const snippet = "<script>window.__VEL=" + JSON.stringify({ base: target.href, home: home || "" }) + ";<\/script>" +
    '<script src="' + APP + 'vel-client.js"><\/script>';
  const inject = (el) => { if (!injected) { injected = true; el.prepend(snippet, { html: true }); } };

  let rewriter = new HTMLRewriter();

  for (const [sel, attr] of attrRules) {
    rewriter = rewriter.on(sel, {
      element(el) {
        const val = el.getAttribute(attr);
        if (val != null) el.setAttribute(attr, proxify(val, target, origin, home));
        if (el.hasAttribute("integrity")) el.removeAttribute("integrity");
      },
    });
  }

  rewriter = rewriter
    .on("[srcset]", {
      element(el) {
        const val = el.getAttribute("srcset");
        if (val != null) el.setAttribute("srcset", proxifySrcset(val, target, origin, home));
      },
    })
    .on("[style]", {
      element(el) {
        const val = el.getAttribute("style");
        if (val != null) el.setAttribute("style", rewriteCss(val, target, origin, home));
      },
    })
    .on('meta[http-equiv="Content-Security-Policy" i]', { element(el) { el.remove(); } })
    .on('meta[name="referrer" i]', { element(el) { el.remove(); } })
    .on('meta[http-equiv="refresh" i]', {
      element(el) {
        const c = el.getAttribute("content");
        if (c) {
          const rewritten = c.replace(/url\s*=\s*(.+)$/i, (m, u) => "url=" + proxify(u.trim(), target, origin, home));
          el.setAttribute("content", rewritten);
        }
      },
    })
    .on("head", {
      element(el) {
        inject(el);
        if (isRedlib(target.hostname)) el.append(REDLIB_STYLE, { html: true });
      },
    })
    // Pages sans <head> (petits jeux HTML…) : on injecte au début de <body>.
    .on("body", { element(el) { inject(el); } });

  // Réécrit aussi le CSS dans les balises <style>.
  let styleBuf = "";
  rewriter = rewriter.on("style", {
    text(t) {
      styleBuf += t.text;
      if (t.lastInTextNode) {
        t.replace(rewriteCss(styleBuf, target, origin, home), { html: false });
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
<h1>${title}</h1><p>${msg}</p><a href="${origin}/__vt/">Retour à l'accueil</a></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

