// Vél·Tube — recherche YouTube (Piped + repli sur YouTube) et lecteur officiel
// avec file de lecture, suivant/précédent, lecture auto, cinéma, plein écran.
(function () {
  "use strict";

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

  var $ = function (id) { return document.getElementById(id); };
  var form = $("yt-form"), input = $("yt-input"), results = $("results"), status = $("status");
  var stage = $("stage"), pTitle = $("player-title"), pMeta = $("player-meta"), pos = $("pos");

  var queue = [];        // [{id,title,author,durText}]
  var current = -1;
  var cards = [];

  // ---------- Lecteur (IFrame API) ----------
  var player = null, apiReady = false, pendingId = null;
  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player("player", {
      host: "https://www.youtube-nocookie.com",
      videoId: "",
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: function () { apiReady = true; if (pendingId) { player.loadVideoById(pendingId); pendingId = null; } },
        onStateChange: function (e) { if (e.data === YT.PlayerState.ENDED) next(); }
      }
    });
  };
  (function loadApi() {
    var s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  })();

  function loadVideo(id) {
    if (apiReady && player) player.loadVideoById(id);
    else pendingId = id;
  }

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

  function playIndex(i) {
    if (i < 0 || i >= queue.length) return;
    current = i;
    var v = queue[i];
    loadVideo(v.id);
    stage.classList.add("on");
    pTitle.textContent = v.title || "";
    pMeta.textContent = v.author || "";
    pos.textContent = (i + 1) + " / " + queue.length;
    $("openyt").href = "https://www.youtube.com/watch?v=" + v.id;
    $("prev").disabled = i <= 0;
    $("next").disabled = i >= queue.length - 1;
    cards.forEach(function (c, k) { c.classList.toggle("playing", k === i); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function next() { if (current < queue.length - 1) playIndex(current + 1); }
  function prev() { if (current > 0) playIndex(current - 1); }

  // Lecture d'une seule vidéo (lien collé) sans liste
  function playSingle(id) {
    queue = [{ id: id, title: "", author: "" }];
    cards = [];
    results.innerHTML = "";
    playIndex(0);
  }

  function renderResults(items) {
    results.innerHTML = "";
    queue = [];
    cards = [];
    items.forEach(function (it) {
      var id = idFromUrl(it.url || it.videoId || "");
      if (!id) return;
      var idx = queue.length;
      queue.push({ id: id, title: it.title || "", author: it.uploaderName || it.author || "", durText: it.durText });
      var card = document.createElement("button");
      card.className = "vid";
      card.innerHTML =
        '<div class="thumb"><img loading="lazy" alt=""><span class="play-ov"><span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 6l10 6-10 6z" fill="#fff"/></svg>' +
        '</span></span><span class="dur"></span></div>' +
        '<div class="info"><div class="t"></div><div class="c"></div></div>';
      card.querySelector("img").src = thumb(id);
      var d = it.durText || fmtDur(it.duration);
      var dur = card.querySelector(".dur");
      if (d) dur.textContent = d; else dur.remove();
      card.querySelector(".t").textContent = it.title || "";
      card.querySelector(".c").textContent = it.uploaderName || it.author || "";
      (function (k) { card.addEventListener("click", function () { playIndex(k); }); })(idx);
      results.appendChild(card);
      cards.push(card);
    });
    return queue.length;
  }

  // ---------- Recherche ----------
  function setStatus(html) { status.innerHTML = html || ""; }

  function proxiedJson(apiUrl) {
    return fetch("/p/" + enc(apiUrl), { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

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
      var rb = $("retry");
      if (rb) rb.addEventListener("click", function () { search(query); });
    }
    function fallback() {
      scrapeYouTube(query)
        .then(function (items) { if (renderResults(items) === 0) giveUp(); else setStatus(""); })
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

  // ---------- Contrôles ----------
  $("prev").addEventListener("click", prev);
  $("next").addEventListener("click", next);
  $("theater").addEventListener("click", function () { document.body.classList.toggle("theater"); });
  $("full").addEventListener("click", function () {
    var f = player && player.getIframe && player.getIframe();
    if (f && f.requestFullscreen) f.requestFullscreen().catch(function () {});
  });
  $("copy").addEventListener("click", function () {
    if (current < 0) return;
    var link = "https://www.youtube.com/watch?v=" + queue[current].id;
    var btn = $("copy");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () { flash(btn, "Copié !"); }).catch(function () { flash(btn, link); });
    } else { flash(btn, link); }
  });
  function flash(btn, txt) {
    var old = btn.innerHTML;
    btn.textContent = txt;
    setTimeout(function () { btn.innerHTML = old; }, 1400);
  }

  // ---------- Entrée ----------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    var id = idFromUrl(q);
    if (id) { playSingle(id); setStatus(""); return; }
    search(q);
  });

  var params = new URLSearchParams(location.search);
  if (params.get("v")) {
    var id0 = idFromUrl(params.get("v")) || params.get("v");
    if (id0) playSingle(id0);
  } else if (params.get("q")) {
    input.value = params.get("q");
    search(params.get("q"));
  } else {
    setStatus("Cherche une vidéo, ou colle un lien YouTube.");
  }
})();
