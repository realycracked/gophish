// Recherche maison (/__vt/api/search) : résultats Bing (web + images) analysés
// côté serveur, plus une fiche Wikipédia. Bing est le seul grand moteur qui
// répond aux serveurs Cloudflare, mais sa page complète arrive « dégradée »
// (sans images ni fiche) et parfois hors sujet : on refait donc la page nous-mêmes.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HEADERS = { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.6", accept: "text/html,application/xhtml+xml" };

export async function searchApi(url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
  const type = url.searchParams.get("type") === "images" ? "images" : "web";
  const page = Math.max(0, Math.min(20, parseInt(url.searchParams.get("page") || "0", 10) || 0));
  if (!q) return json({ error: "Recherche vide" }, 400);

  let body;
  if (type === "images") {
    body = { images: await bingImages(q, page * 35, 35) };
  } else {
    const [web, images, wiki] = await Promise.all([
      bingWeb(q, page),
      page === 0 ? bingImages(q, 0, 12).catch(() => []) : [],
      page === 0 ? wikipedia(q).catch(() => null) : null,
    ]);
    body = { results: web, images, wiki };
  }
  return json(body, 200, 600);
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

// ---------- Bing web ----------
function words(q) {
  return q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}
function relevance(results, q) {
  const ws = words(q);
  if (!ws.length || !results.length) return 1;
  const hit = results.filter((r) => {
    const t = (r.title + " " + r.snippet + " " + r.url).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return ws.every((w) => t.includes(w));
  }).length;
  return hit / results.length;
}

async function bingWeb(q, page) {
  // Bing répond parfois « à côté » aux serveurs Cloudflare (ex. « claude monet »
  // → que des pages claude.ai) : on garde la réponse la plus pertinente.
  const variants = ["setlang=fr&cc=FR&mkt=fr-FR", "setlang=fr", "mkt=fr-FR&form=QBLH"];
  let best = [], bestScore = -1;
  for (const v of variants) {
    const u = `https://www.bing.com/search?q=${encodeURIComponent(q)}&${v}${page ? "&first=" + (page * 10 + 1) : ""}`;
    let res;
    try { res = await parseBingWeb(await fetch(u, { headers: HEADERS })); } catch { continue; }
    const score = relevance(res, q);
    if (score > bestScore) { best = res; bestScore = score; }
    if (score >= 0.5 && res.length >= 5) break;
  }
  return best;
}

async function parseBingWeb(resp) {
  const out = [];
  let cur = null, inTitle = false, inSnip = false;
  const rw = new HTMLRewriter()
    .on("li.b_algo", {
      element(el) {
        cur = { url: "", title: "", snippet: "", site: "" };
        out.push(cur);
      },
    })
    .on("li.b_algo h2 a", {
      element(el) {
        if (!cur || cur.url) return;
        cur.url = realUrl(el.getAttribute("href") || "");
        inTitle = true;
        el.onEndTag(() => { inTitle = false; });
      },
      text(t) { if (cur && inTitle) cur.title += t.text; },
    })
    .on("li.b_algo .b_caption p, li.b_algo p.b_lineclamp2, li.b_algo p.b_lineclamp3, li.b_algo p.b_lineclamp4, li.b_algo .b_snippet", {
      element(el) {
        if (!cur || cur.snippet) return;
        inSnip = true;
        el.onEndTag(() => { inSnip = false; });
      },
      text(t) { if (cur && inSnip) cur.snippet += t.text; },
    });
  await rw.transform(resp).arrayBuffer();
  return out
    .map((r) => ({ ...r, title: decode(r.title).trim(), snippet: decode(r.snippet).replace(/\s+/g, " ").trim() }))
    .filter((r) => /^https?:\/\//.test(r.url) && r.title)
    .map((r) => { try { r.site = new URL(r.url).hostname.replace(/^www\./, ""); } catch {} return r; })
    .slice(0, 12);
}

// Liens Bing « /ck/a?...&u=a1<base64>" -> vraie adresse.
function realUrl(href) {
  try {
    const u = new URL(decode(href), "https://www.bing.com");
    if (u.hostname.endsWith("bing.com") && u.pathname.startsWith("/ck/")) {
      const p = u.searchParams.get("u") || "";
      if (p.startsWith("a1")) {
        const b = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b + "===".slice((b.length + 3) % 4));
        return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      }
    }
    return u.href;
  } catch {
    return "";
  }
}

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

// ---------- Bing images ----------
async function bingImages(q, first, count) {
  const u = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=${first}&count=${count}&mmasync=1&setlang=fr&mkt=fr-FR`;
  const resp = await fetch(u, { headers: HEADERS });
  const out = [];
  const rw = new HTMLRewriter().on("a.iusc", {
    element(el) {
      try {
        const m = JSON.parse(decode(el.getAttribute("m") || ""));
        if (m.murl && m.turl) out.push({ img: m.murl, thumb: m.turl, page: m.purl || m.murl, title: decode(m.t || "") });
      } catch {}
    },
  });
  await rw.transform(resp).arrayBuffer();
  return out.slice(0, count);
}

// ---------- Wikipédia ----------
async function wikipedia(q) {
  const s = await fetch(
    "https://fr.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=" + encodeURIComponent(q),
    { headers: { "user-agent": "VelTube/1.0 (recherche)" } }
  ).then((r) => r.json());
  const hit = s?.query?.search?.[0];
  if (!hit) return null;
  // On ne garde la fiche que si son titre correspond vraiment à la recherche.
  const tw = words(hit.title), qw = words(q);
  if (!tw.length || !tw.every((w) => qw.some((x) => x.startsWith(w) || w.startsWith(x)))) return null;
  const sum = await fetch(
    "https://fr.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(hit.title.replace(/ /g, "_")),
    { headers: { "user-agent": "VelTube/1.0 (recherche)" } }
  ).then((r) => r.json());
  if (!sum || sum.type === "disambiguation" || !sum.extract) return null;
  return {
    title: sum.title,
    description: sum.description || "",
    extract: sum.extract.slice(0, 600),
    image: sum.thumbnail?.source || "",
    url: sum.content_urls?.mobile?.page || sum.content_urls?.desktop?.page || "",
  };
}
