// Vél·Tube — recherche YouTube (Piped + repli), lecteur avec file de lecture,
// historique + reprise, mode musique, et DEUX modes de lecture :
//  - "rapide"      : lecteur officiel, vidéo directe depuis Google (rapide).
//  - "compatible"  : la vidéo passe par le proxy (marche sur les réseaux qui
//                    bloquent YouTube, mais plus lent).
// Détection automatique du blocage au chargement.
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
  var listHead = $("list-head"), listTitle = $("list-title"), listAction = $("list-action");
  var netnote = $("netnote"), modeLbl = $("mode-lbl");

  var queue = [], current = -1, cards = [];
  var proxyMode = false;

  // ---------- Stockage local ----------
  function load(key, def) { try { return JSON.parse(localStorage.getItem(key)) || def; } catch (e) { return def; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function getPref() { try { return localStorage.getItem("vt_mode") || "auto"; } catch (e) { return "auto"; } }
  function setPref(v) { try { localStorage.setItem("vt_mode", v); } catch (e) {} }
  var history = load("vt_hist", []);
  var positions = load("vt_pos", {});

  function remember(v) {
    history = history.filter(function (h) { return h.id !== v.id; });
    history.unshift({ id: v.id, title: v.title, author: v.author, durText: v.durText, ts: Date.now() });
    if (history.length > 60) history = history.slice(0, 60);
    save("vt_hist", history);
  }

  function fmtDur(s) {
    if (s == null || isNaN(s)) return "";
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(sec).padStart(2, "0");
  }
  function thumb(id) {
    var u = "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
    return proxyMode ? "/p/" + enc(u) : u;
  }
  function idFromUrl(u) {
    if (!u) return null;
    var m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/) || u.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
            u.match(/\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})/) || u.match(/^([A-Za-z0-9_-]{11})$/);
    return m ? m[1] : null;
  }
  function currentIframe() { return document.querySelector(".player-box iframe"); }

  // ---------- Lecteur : mode rapide (IFrame API) ----------
  var player = null, apiLoaded = false, apiReady = false, pending = null;
  function ensureApi() {
    if (apiLoaded) return;
    apiLoaded = true;
    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player("player", {
        host: "https://www.youtube-nocookie.com", videoId: "",
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: function () { apiReady = true; if (pending) { apiPlay(pending.id, pending.start); pending = null; } },
          onStateChange: function (e) {
            if (e.data === YT.PlayerState.ENDED) {
              if (current >= 0 && queue[current]) { delete positions[queue[current].id]; save("vt_pos", positions); }
              next();
            }
          }
        }
      });
    };
    var s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s);
  }
  function apiPlay(id, start) { player.loadVideoById({ videoId: id, startSeconds: start || 0 }); }

  // ---------- Lecteur : mode compatible (iframe via proxy) ----------
  function loadProxyVideo(id, start) {
    var u = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0&modestbranding=1&playsinline=1" + (start ? "&start=" + Math.floor(start) : "");
    $("player").innerHTML = '<iframe src="/p/' + enc(u) + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="origin"></iframe>';
  }

  function loadVideo(id, start) {
    if (proxyMode) { loadProxyVideo(id, start); return; }
    ensureApi();
    if (apiReady && player) apiPlay(id, start); else pending = { id: id, start: start };
  }

  // Sauvegarde périodique de la position (mode rapide uniquement)
  setInterval(function () {
    try {
      if (proxyMode || current < 0 || !player || !player.getCurrentTime) return;
      var t = player.getCurrentTime(), d = player.getDuration();
      if (!d || d <= 0) return;
      var id = queue[current].id;
      if (t > 5 && t < d - 20) positions[id] = Math.floor(t); else delete positions[id];
      save("vt_pos", positions);
    } catch (e) {}
  }, 5000);

  function playIndex(i) {
    if (i < 0 || i >= queue.length) return;
    current = i;
    var v = queue[i];
    loadVideo(v.id, positions[v.id] || 0);
    remember(v);
    stage.classList.add("on");
    pTitle.textContent = v.title || "Lecture";
    pMeta.textContent = v.author || "";
    pos.textContent = (i + 1) + " / " + queue.length;
    $("openyt").href = "https://www.youtube.com/watch?v=" + v.id;
    $("prev").disabled = i <= 0;
    $("next").disabled = i >= queue.length - 1;
    cards.forEach(function (c, k) { c.classList.toggle("playing", k === i); });
    if (!document.body.classList.contains("music")) window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function next() { if (current < queue.length - 1) playIndex(current + 1); }
  function prev() { if (current > 0) playIndex(current - 1); }
  function playSingle(id) { queue = [{ id: id, title: "", author: "" }]; cards = []; results.innerHTML = ""; hideList(); playIndex(0); }

  function renderResults(items) {
    results.innerHTML = ""; queue = []; cards = [];
    items.forEach(function (it) {
      var id = idFromUrl(it.url || it.videoId || "");
      if (!id) return;
      var idx = queue.length;
      queue.push({ id: id, title: it.title || "", author: it.uploaderName || it.author || "", durText: it.durText });
      var card = document.createElement("button");
      card.className = "vid";
      card.innerHTML =
        '<div class="thumb"><img loading="lazy" alt=""><span class="play-ov"><span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 6l10 6-10 6z" fill="#fff"/></svg></span></span>' +
        '<span class="dur"></span></div><div class="info"><div class="t"></div><div class="c"></div></div>';
      card.querySelector("img").src = thumb(id);
      var d = it.durText || fmtDur(it.duration);
      var dur = card.querySelector(".dur");
      if (d) dur.textContent = d; else dur.remove();
      card.querySelector(".t").textContent = it.title || "";
      card.querySelector(".c").textContent = it.uploaderName || it.author || "";
      (function (k) { card.addEventListener("click", function () { playIndex(k); }); })(idx);
      results.appendChild(card); cards.push(card);
    });
    return queue.length;
  }

  function showList(title, actionLabel, actionFn) {
    listTitle.textContent = title;
    if (actionLabel) { listAction.textContent = actionLabel; listAction.onclick = actionFn; listAction.hidden = false; } else listAction.hidden = true;
    listHead.hidden = false;
  }
  function hideList() { listHead.hidden = true; }
  function showHistory() {
    if (!history.length) { setStatus("Cherche une vidéo, colle un lien, ou reviens ici pour retrouver ton historique."); return; }
    renderResults(history.map(function (h) { return { videoId: h.id, title: h.title, uploaderName: h.author, durText: h.durText }; }));
    setStatus("");
    showList("Reprendre", "Vider l'historique", function () {
      history = []; save("vt_hist", history); positions = {}; save("vt_pos", positions);
      results.innerHTML = ""; hideList(); showHistory();
    });
  }

  // ---------- Recherche ----------
  function setStatus(html) { status.innerHTML = html || ""; }
  function proxiedJson(apiUrl) {
    return fetch("/p/" + enc(apiUrl), { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function scrapeYouTube(query) {
    var url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
    return fetch("/p/" + enc(url)).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        var m = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s);
        if (!m) return [];
        var data; try { data = JSON.parse(m[1]); } catch (e) { return []; }
        var out = [];
        (function collect(node) {
          if (!node || typeof node !== "object") return;
          if (node.videoRenderer) {
            var v = node.videoRenderer;
            var title = (v.title && (v.title.simpleText || (v.title.runs && v.title.runs[0] && v.title.runs[0].text))) || "";
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
    setStatus("Recherche…"); hideList(); results.innerHTML = "";
    var i = 0;
    function giveUp() {
      setStatus("Aucune source de recherche ne répond pour le moment. <button id=\"retry\">Réessayer</button>, ou colle directement un lien YouTube.");
      var rb = $("retry"); if (rb) rb.addEventListener("click", function () { search(query); });
    }
    function fallback() { scrapeYouTube(query).then(function (items) { if (renderResults(items) === 0) giveUp(); else { setStatus(""); showList("Résultats"); } }).catch(giveUp); }
    function tryNext() {
      if (i >= INSTANCES.length) { fallback(); return; }
      var api = INSTANCES[i++] + "/search?q=" + encodeURIComponent(query) + "&filter=videos";
      proxiedJson(api).then(function (data) {
        var items = (data && data.items) || [];
        if (renderResults(items) === 0) tryNext(); else { setStatus(""); showList("Résultats"); }
      }).catch(function () { tryNext(); });
    }
    tryNext();
  }

  // ---------- Contrôles ----------
  $("prev").addEventListener("click", prev);
  $("next").addEventListener("click", next);
  $("music").addEventListener("click", function () { this.classList.toggle("active", document.body.classList.toggle("music")); });
  $("theater").addEventListener("click", function () { document.body.classList.toggle("theater"); });
  $("full").addEventListener("click", function () {
    var f = currentIframe();
    if (f && f.requestFullscreen) f.requestFullscreen().catch(function () {});
  });
  $("copy").addEventListener("click", function () {
    if (current < 0) return;
    var link = "https://www.youtube.com/watch?v=" + queue[current].id, btn = $("copy");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { flash(btn, "Copié !"); }).catch(function () { flash(btn, link); });
    else flash(btn, link);
  });
  $("mode").addEventListener("click", function () { setPref(proxyMode ? "direct" : "proxy"); location.reload(); });
  function flash(btn, txt) { var old = btn.innerHTML; btn.textContent = txt; setTimeout(function () { btn.innerHTML = old; }, 1400); }

  function updateModeUI(auto) {
    modeLbl.textContent = proxyMode ? "Compatible" : "Rapide";
    if (proxyMode) {
      netnote.hidden = false;
      netnote.innerHTML = (auto ? "<b>YouTube semble bloqué sur ce réseau.</b> Lecture via le proxy (plus lent)."
                                : "<b>Mode compatible.</b> La vidéo passe par le proxy (plus lent).") +
        " <button id=\"flip\">Repasser en mode rapide</button>";
      var fb = $("flip"); if (fb) fb.addEventListener("click", function () { setPref("direct"); location.reload(); });
    } else {
      netnote.hidden = true;
    }
  }

  // ---------- Détection du réseau ----------
  function probe(cb) {
    var img = new Image(), done = false;
    var to = setTimeout(function () { if (!done) { done = true; cb(false); } }, 2500);
    img.onload = function () { if (!done) { done = true; clearTimeout(to); cb(true); } };
    img.onerror = function () { if (!done) { done = true; clearTimeout(to); cb(false); } };
    img.src = "https://i.ytimg.com/vi/aqz-KE-bpKQ/default.jpg?t=" + Date.now();
  }

  function startup() {
    var params = new URLSearchParams(location.search);
    if (params.get("v")) { var id0 = idFromUrl(params.get("v")) || params.get("v"); if (id0) playSingle(id0); }
    else if (params.get("q")) { input.value = params.get("q"); search(params.get("q")); }
    else showHistory();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim(); if (!q) return;
    var id = idFromUrl(q);
    if (id) { playSingle(id); setStatus(""); return; }
    search(q);
  });

  // Init : résout le mode (préférence ou détection auto), puis démarre.
  (function init() {
    var pref = getPref();
    function go(isProxy, auto) { proxyMode = isProxy; updateModeUI(auto); if (!proxyMode) ensureApi(); startup(); }
    if (pref === "direct") go(false, false);
    else if (pref === "proxy") go(true, false);
    else probe(function (ok) { go(!ok, true); });
  })();
})();
