// Vél·Tube — recherche YouTube (via Piped) + lecture par le lecteur officiel.
// La recherche passe par notre proxy (pas de CORS, pas de clé). La lecture se
// fait avec l'iframe YouTube officielle : la vidéo vient direct de Google.
(function () {
  "use strict";

  // Instances Piped publiques (API). Essayées dans l'ordre jusqu'à ce qu'une réponde.
  // Si tu en connais une meilleure, ajoute-la en tête de liste.
  var INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://api.piped.private.coffee",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.r4fo.com"
  ];

  function enc(url) {
    var bytes = new TextEncoder().encode(url);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  var form = document.getElementById("yt-form");
  var input = document.getElementById("yt-input");
  var results = document.getElementById("results");
  var status = document.getElementById("status");
  var playerWrap = document.getElementById("player-wrap");
  var player = document.getElementById("player");
  var pTitle = document.getElementById("player-title");
  var pMeta = document.getElementById("player-meta");

  function setStatus(html) { status.innerHTML = html || ""; }

  function fmtDur(s) {
    if (s == null || isNaN(s)) return "";
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(sec).padStart(2, "0");
  }

  function thumb(id) { return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"; }

  function idFromUrl(u) {
    if (!u) return null;
    var m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
            u.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
            u.match(/\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})/) ||
            u.match(/^([A-Za-z0-9_-]{11})$/);
    return m ? m[1] : null;
  }

  function play(id, title, author) {
    player.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0";
    pTitle.textContent = title || "";
    pMeta.innerHTML = (author ? author + " · " : "") +
      '<a href="/p/' + enc("https://www.youtube.com/watch?v=" + id) +
      '">ne marche pas ? ouvrir via le proxy</a>';
    playerWrap.style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderResults(items) {
    results.innerHTML = "";
    var n = 0;
    items.forEach(function (it) {
      var id = idFromUrl(it.url || it.videoId || "");
      if (!id) return;
      n++;
      var card = document.createElement("button");
      card.className = "vid";
      card.innerHTML =
        '<div class="thumb"><img loading="lazy" alt=""><span class="dur"></span></div>' +
        '<div class="info"><div class="t"></div><div class="c"></div></div>';
      card.querySelector("img").src = thumb(id);
      var d = it.durText || fmtDur(it.duration);
      var dur = card.querySelector(".dur");
      if (d) dur.textContent = d; else dur.remove();
      card.querySelector(".t").textContent = it.title || "";
      card.querySelector(".c").textContent = it.uploaderName || it.author || "";
      card.addEventListener("click", function () { play(id, it.title, it.uploaderName || it.author); });
      results.appendChild(card);
    });
    return n;
  }

  // Récupère via notre proxy (évite CORS), en essayant chaque instance.
  function proxiedJson(apiUrl) {
    return fetch("/p/" + enc(apiUrl), { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  // Plan B : extrait les résultats directement de la page YouTube (via le proxy).
  // YouTube embarque ses données dans "ytInitialData" ; on les lit sans clé.
  function scrapeYouTube(query) {
    var url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
    return fetch("/p/" + enc(url)).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (html) {
      var m = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) ||
              html.match(/ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s);
      if (!m) return [];
      var data;
      try { data = JSON.parse(m[1]); } catch (e) { return []; }
      var out = [];
      (function collect(node) {
        if (!node || typeof node !== "object") return;
        if (node.videoRenderer) {
          var v = node.videoRenderer;
          var title = (v.title && (v.title.simpleText ||
            (v.title.runs && v.title.runs[0] && v.title.runs[0].text))) || "";
          var author = v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text;
          var durText = v.lengthText && v.lengthText.simpleText;
          if (v.videoId && title) out.push({ url: "/watch?v=" + v.videoId, title: title, uploaderName: author, durText: durText });
        }
        for (var k in node) collect(node[k]);
      })(data);
      return out;
    });
  }

  function search(query) {
    setStatus("Recherche…");
    results.innerHTML = "";
    var i = 0;
    function giveUp() {
      setStatus("Aucune source de recherche ne répond pour le moment. " +
        'Tu peux <button id="retry">réessayer</button>, ou coller directement un lien YouTube dans la barre.');
      var rb = document.getElementById("retry");
      if (rb) rb.addEventListener("click", function () { search(query); });
    }
    function fallback() {
      scrapeYouTube(query)
        .then(function (items) {
          if (renderResults(items) === 0) giveUp(); else setStatus("");
        })
        .catch(giveUp);
    }
    function tryNext() {
      if (i >= INSTANCES.length) { fallback(); return; }
      var api = INSTANCES[i++] + "/search?q=" + encodeURIComponent(query) + "&filter=videos";
      proxiedJson(api)
        .then(function (data) {
          var items = (data && data.items) || [];
          if (renderResults(items) === 0) tryNext(); else setStatus("");
        })
        .catch(function () { tryNext(); });
    }
    tryNext();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    var id = idFromUrl(q);
    if (id) { play(id); setStatus(""); results.innerHTML = ""; return; }
    search(q);
  });

  // Lien direct dans l'URL : /youtube.html?v=ID ou ?q=recherche
  var params = new URLSearchParams(location.search);
  if (params.get("v")) {
    var id0 = idFromUrl(params.get("v")) || params.get("v");
    if (id0) play(id0);
  } else if (params.get("q")) {
    input.value = params.get("q");
    search(params.get("q"));
  } else {
    setStatus("Cherche une vidéo, ou colle un lien YouTube.");
  }
})();
