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
              next(true);
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
    // "Suivant" reste actif en fin de liste : il enchaîne alors sur des vidéos liées.
    $("next").disabled = i >= queue.length - 1 && !autoRelated;
    cards.forEach(function (c, k) { c.classList.toggle("playing", k === i); });
    refreshSaveUI();
    if (!document.body.classList.contains("music")) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Suivant : vidéo suivante de la liste, sinon (lecture auto activée) on
  // récupère les vidéos liées à celle en cours et on les ajoute à la file.
  var fetchingRelated = false;
  function next() {
    if (current < queue.length - 1) { playIndex(current + 1); return; }
    if (!autoRelated || current < 0 || fetchingRelated) return;
    fetchingRelated = true;
    var from = queue[current].id;
    pipedAny("/streams/" + from, function (d) {
      return ((d && d.relatedStreams) || []).filter(function (x) { return !x.type || x.type === "stream"; });
    }).then(function (items) {
      if (queue.length && queue[current] && queue[current].id !== from) return; // l'utilisateur a changé de vidéo
      if (renderResults(items, true) > 0) {
        if (listHead.hidden) showList("À suivre");
        playIndex(current + 1);
      }
    }).catch(function () {}).then(function () { fetchingRelated = false; });
  }
  function prev() { if (current > 0) playIndex(current - 1); }
  function playSingle(id) { queue = [{ id: id, title: "", author: "" }]; cards = []; results.innerHTML = ""; hideList(); playIndex(0); }

  // Affiche des vidéos. append=true les ajoute à la file existante (sans doublons)
  // et renvoie le nombre ajouté ; sinon remplace la liste et renvoie sa taille.
  function renderResults(items, append) {
    if (!append) { results.innerHTML = ""; queue = []; cards = []; }
    var seen = {}, added = 0;
    queue.forEach(function (q) { seen[q.id] = 1; });
    items.forEach(function (it) {
      var id = idFromUrl(it.url || it.videoId || "");
      if (!id || seen[id]) return;
      seen[id] = 1; added++;
      var idx = queue.length;
      var v = { id: id, title: it.title || "", author: it.uploaderName || it.author || "", durText: it.durText || fmtDur(it.duration) };
      queue.push(v);
      var card = document.createElement("button");
      card.className = "vid";
      card.innerHTML =
        '<div class="thumb"><img loading="lazy" alt=""><span class="play-ov"><span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 6l10 6-10 6z" fill="#fff"/></svg></span></span>' +
        '<span class="dur"></span>' +
        '<span class="save" role="button" tabindex="0" title="À regarder plus tard" aria-label="À regarder plus tard">' +
        '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="2"/><path d="M12 8v4l3 2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></span>' +
        '</div><div class="info"><div class="t"></div><div class="c"></div></div>';
      card.querySelector("img").src = thumb(id);
      var dur = card.querySelector(".dur");
      if (v.durText) dur.textContent = v.durText; else dur.remove();
      card.querySelector(".t").textContent = v.title;
      card.querySelector(".c").textContent = v.author;
      var sv = card.querySelector(".save");
      sv.classList.toggle("on", inList(later, id));
      function onSave(e) {
        e.stopPropagation(); e.preventDefault();
        var on = toggleIn("later", v);
        sv.classList.toggle("on", on);
        toast(on ? "Ajouté à « Plus tard »" : "Retiré de « Plus tard »");
        refreshSaveUI();
      }
      sv.addEventListener("click", onSave);
      sv.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") onSave(e); });
      (function (k) { card.addEventListener("click", function () { playIndex(k); }); })(idx);
      results.appendChild(card); cards.push(card);
    });
    return append ? added : queue.length;
  }

  // ---------- Favoris & À regarder plus tard ----------
  var favs = load("vt_fav", []), later = load("vt_later", []);
  var autoRelated = load("vt_auto", true);
  function inList(list, id) { return list.some(function (x) { return x.id === id; }); }
  function toggleIn(which, v) {
    var list = which === "fav" ? favs : later, key = which === "fav" ? "vt_fav" : "vt_later";
    var i = list.findIndex(function (x) { return x.id === v.id; });
    if (i >= 0) list.splice(i, 1);
    else { list.unshift({ id: v.id, title: v.title, author: v.author, durText: v.durText }); if (list.length > 200) list.length = 200; }
    save(key, list);
    return i < 0;
  }
  function refreshSaveUI() {
    var v = current >= 0 ? queue[current] : null;
    $("fav").classList.toggle("active", !!v && inList(favs, v.id));
    $("later").classList.toggle("active", !!v && inList(later, v.id));
    $("auto").classList.toggle("active", autoRelated);
  }
  var toastTimer;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1600);
  }
  function asItems(list) { return list.map(function (h) { return { videoId: h.id, title: h.title, uploaderName: h.author, durText: h.durText }; }); }

  // ---------- Listes : Tendances / Reprendre / Favoris / Plus tard ----------
  function markView(name) {
    document.querySelectorAll("#views button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-view") === name); });
  }
  function showView(name) {
    markView(name);
    ++searchSeq; // annule une recherche ou un chargement en cours
    if (name === "trend") { showTrending(); return; }
    if (name === "hist") { showHistory(); return; }
    var isFav = name === "fav", list = isFav ? favs : later;
    if (!list.length) {
      results.innerHTML = ""; hideList();
      setStatus(isFav ? "Aucun favori pour l'instant. Pendant une vidéo, appuie sur « Favori »."
                      : "Rien à regarder plus tard. Appuie sur l'horloge d'une vidéo pour l'ajouter.");
      return;
    }
    renderResults(asItems(list)); setStatus("");
    showList(isFav ? "Favoris" : "À regarder plus tard", "Tout effacer", function () {
      list.length = 0; save(isFav ? "vt_fav" : "vt_later", list); showView(name);
    });
  }
  function showTrending() {
    var seq = searchSeq;
    results.innerHTML = ""; hideList(); setStatus("Chargement des tendances…");
    pipedAny("/trending?region=FR", function (d) { return Array.isArray(d) ? d : []; })
      .then(function (items) {
        if (seq !== searchSeq) return;
        if (renderResults(items) === 0) throw new Error("vide");
        setStatus(""); showList("Tendances en France");
      })
      .catch(function () {
        if (seq !== searchSeq) return;
        setStatus("Les tendances ne répondent pas pour le moment. Cherche une vidéo, ou ouvre « Reprendre ».");
      });
  }
  // Interroge toutes les instances Piped en parallèle, garde la 1re réponse non vide.
  function pipedAny(path, pick) {
    return firstNonEmpty(INSTANCES.map(function (inst) { return proxiedJson(inst + path).then(pick); }));
  }

  function showList(title, actionLabel, actionFn) {
    listTitle.textContent = title;
    if (actionLabel) { listAction.textContent = actionLabel; listAction.onclick = actionFn; listAction.hidden = false; } else listAction.hidden = true;
    listHead.hidden = false;
  }
  function hideList() { listHead.hidden = true; }
  function showHistory() {
    if (!history.length) { results.innerHTML = ""; hideList(); setStatus("Pas encore d'historique. Les vidéos que tu regardes apparaîtront ici."); return; }
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
  // Résout avec le premier résultat non vide parmi plusieurs requêtes lancées
  // en même temps ; échoue seulement si toutes échouent ou reviennent vides.
  function firstNonEmpty(promises) {
    return new Promise(function (resolve, reject) {
      var left = promises.length;
      if (!left) { reject(); return; }
      promises.forEach(function (p) {
        p.then(function (items) {
          if (items && items.length) resolve(items); else if (--left === 0) reject();
        }, function () { if (--left === 0) reject(); });
      });
    });
  }

  var searchSeq = 0;
  function search(query) {
    var seq = ++searchSeq;
    markView("");
    setStatus("Recherche…"); hideList(); results.innerHTML = "";
    function giveUp() {
      if (seq !== searchSeq) return;
      setStatus("Aucune source de recherche ne répond pour le moment. <button id=\"retry\">Réessayer</button>, ou colle directement un lien YouTube.");
      var rb = $("retry"); if (rb) rb.addEventListener("click", function () { search(query); });
    }
    // Tous les serveurs Piped en parallèle : le plus rapide qui répond gagne.
    var asks = INSTANCES.map(function (inst) {
      return proxiedJson(inst + "/search?q=" + encodeURIComponent(query) + "&filter=videos")
        .then(function (data) { return (data && data.items) || []; });
    });
    firstNonEmpty(asks)
      .catch(function () { return scrapeYouTube(query); })
      .then(function (items) {
        if (seq !== searchSeq) return; // une recherche plus récente a été lancée
        if (renderResults(items || []) === 0) giveUp(); else { setStatus(""); showList("Résultats"); }
      })
      .catch(giveUp);
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
  $("fav").addEventListener("click", function () {
    if (current < 0) return;
    var on = toggleIn("fav", queue[current]);
    refreshSaveUI(); toast(on ? "Ajouté aux favoris" : "Retiré des favoris");
  });
  $("later").addEventListener("click", function () {
    if (current < 0) return;
    var v = queue[current], on = toggleIn("later", v);
    refreshSaveUI(); toast(on ? "Ajouté à « Plus tard »" : "Retiré de « Plus tard »");
    var c = cards[current]; if (c) { var s = c.querySelector(".save"); if (s) s.classList.toggle("on", on); }
  });
  $("auto").addEventListener("click", function () {
    autoRelated = !autoRelated; save("vt_auto", autoRelated);
    refreshSaveUI(); toast(autoRelated ? "Lecture auto : activée" : "Lecture auto : désactivée");
    if (current >= 0) $("next").disabled = current >= queue.length - 1 && !autoRelated;
  });
  document.querySelectorAll("#views button").forEach(function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
  });
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
    else showView("trend");
    refreshSaveUI();
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
