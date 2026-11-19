// Accueil Vél·Tube : écran façon téléphone (horloge, recherche, applis, dock).
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function enc(url) {
    var bytes = new TextEncoder().encode(url);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // /w/<origine>/<chemin> : le proxy garde le vrai chemin du site.
  function toProxy(url) { var u = new URL(url); return "/w/" + enc(u.origin) + u.pathname + u.search + u.hash; }
  function openProxy(url) { window.location.href = toProxy(url); }
  function openYouTube(q) { window.location.href = "/__vt/youtube?q=" + encodeURIComponent(q); }

  function resolveQuery(raw) {
    var q = raw.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (/^[^\s.]+\.[^\s]{2,}$/.test(q) && !/\s/.test(q)) return "https://" + q;
    // Bing : le seul grand moteur qui accepte les recherches venant de Cloudflare.
    return "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=fr";
  }

  // Adresse tapée pour un raccourci -> URL, ou null. "twitch" tout court -> twitch.com.
  function siteUrl(raw) {
    var q = raw.trim();
    if (/^[a-z0-9-]+$/i.test(q)) q += ".com";
    if (/^https?:\/\//i.test(q)) { try { return new URL(q).href; } catch (e) { return null; } }
    if (/^[^\s.]+\.[^\s]{2,}$/.test(q)) { try { return new URL("https://" + q).href; } catch (e) { return null; } }
    return null;
  }
  function defaultName(url) {
    try {
      var h = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
      return h.charAt(0).toUpperCase() + h.slice(1);
    } catch (e) { return "Site"; }
  }
  function colorOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return "c" + (h % 7);
  }

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  var toastTimer;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1600);
  }

  // ---------- Icône : vrai logo du site, sinon sa première lettre ----------
  function fillIcon(el, name, url) {
    el.className = "ico " + colorOf(name);
    el.textContent = name.charAt(0).toUpperCase();
    if (!url) return;
    var img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.onload = function () {
      if (img.naturalWidth < 16) return; // image vide : on garde la lettre
      el.className = "ico logo"; el.textContent = ""; el.appendChild(img);
    };
    img.src = "/__vt/icon?u=" + encodeURIComponent(url);
  }

  // ---------- Horloge ----------
  function tick() {
    var d = new Date();
    $("clk").textContent = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    $("date").textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  }
  tick(); setInterval(tick, 5000);

  // ---------- Recherche : YouTube ou Web ----------
  var mode = read("vt_mode") === "web" ? "web" : "yt";
  var q = $("q");
  function setMode(m) {
    mode = m; store("vt_mode", m);
    document.querySelectorAll(".seg button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-m") === m); });
    q.placeholder = m === "yt" ? "Une vidéo…" : "Un site, une recherche…";
    q.setAttribute("inputmode", m === "yt" ? "search" : "url");
  }
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () { setMode(b.getAttribute("data-m")); q.focus(); });
  });
  setMode(mode);
  $("search").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = q.value.trim();
    if (!v) return;
    if (mode === "yt") return openYouTube(v);
    var url = resolveQuery(v);
    if (url) openProxy(url);
  });

  // ---------- Applis (gardées sur l'appareil) ----------
  var DEFAULT_SITES = [
    { name: "Reddit", url: "https://www.reddit.com" },
    { name: "Bing", url: "https://www.bing.com" },
    { name: "Wikipédia", url: "https://www.wikipedia.org" }
  ];
  function loadSites() {
    try {
      var s = JSON.parse(read("vt_sites"));
      // DuckDuckGo refuse les recherches via Cloudflare : on le remplace par Bing.
      if (Array.isArray(s)) return s.map(function (x) { return /duckduckgo\.com/i.test(x.url) ? { name: "Bing", url: "https://www.bing.com" } : x; });
    } catch (e) {}
    return DEFAULT_SITES.slice();
  }
  function saveSites() { store("vt_sites", JSON.stringify(sites)); }

  var sites = loadSites();
  var screen = $("screen"), grid = $("grid");
  function editing() { return screen.classList.contains("editing"); }
  function setEditing(on) { screen.classList.toggle("editing", on); }

  function appEl(tag, name) {
    var el = document.createElement(tag);
    el.className = "app";
    var ico = document.createElement("span"); ico.className = "ico";
    var lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = name;
    el.appendChild(ico); el.appendChild(lbl);
    return el;
  }

  function render() {
    grid.innerHTML = "";

    var yt = appEl("a", "YouTube");
    yt.href = "/__vt/youtube";
    yt.firstChild.className = "ico ico-yt";
    grid.appendChild(yt);

    sites.forEach(function (s, i) {
      var b = appEl("a", s.name);
      b.href = toProxy(s.url);
      b.title = s.url;
      b.setAttribute("data-i", i);
      fillIcon(b.firstChild, s.name, s.url);
      var del = document.createElement("span"); del.className = "del"; del.textContent = "✕";
      del.setAttribute("aria-hidden", "true");
      b.appendChild(del);

      // Appui long : mode édition.
      var timer = null, longPressed = false;
      b.addEventListener("pointerdown", function () {
        longPressed = false;
        timer = setTimeout(function () { longPressed = true; setEditing(true); if (navigator.vibrate) navigator.vibrate(15); }, 480);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
        b.addEventListener(ev, function () { clearTimeout(timer); });
      });
      b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
      b.addEventListener("click", function (e) {
        if (longPressed) { e.preventDefault(); longPressed = false; return; }
        if (editing()) {
          e.preventDefault();
          sites.splice(i, 1); saveSites(); render();
          toast(s.name + " retiré");
        }
      });
      grid.appendChild(b);
    });

    var add = appEl("button", "Ajouter");
    add.type = "button";
    add.firstChild.className = "ico add";
    add.firstChild.textContent = "+";
    add.addEventListener("click", openSheet);
    grid.appendChild(add);
  }

  $("done").addEventListener("click", function () { setEditing(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { setEditing(false); closeSheet(); }
  });

  // ---------- Feuille d'ajout, avec aperçu du logo ----------
  var au = $("au"), an = $("an"), pv = $("pv"), pvn = $("pvn"), err = $("err");
  var previewTimer;
  function updatePreview() {
    var url = siteUrl(au.value);
    var name = an.value.trim() || (url ? defaultName(url) : "Nouveau site");
    pvn.textContent = name;
    err.textContent = "";
    pv.innerHTML = "";
    fillIcon(pv, name, null);
    clearTimeout(previewTimer);
    if (url) previewTimer = setTimeout(function () { fillIcon(pv, name, url); }, 350);
  }
  au.addEventListener("input", updatePreview);
  an.addEventListener("input", updatePreview);

  function openSheet() {
    setEditing(false);
    au.value = ""; an.value = ""; updatePreview();
    screen.classList.add("open");
    setTimeout(function () { au.focus(); }, 60);
  }
  function closeSheet() { screen.classList.remove("open"); }
  $("veil").addEventListener("click", closeSheet);

  $("sheet").addEventListener("submit", function (e) {
    e.preventDefault();
    var url = siteUrl(au.value);
    if (!url) { err.textContent = "Entre une adresse, par ex. twitch.tv"; au.focus(); return; }
    var name = (an.value.trim() || defaultName(url)).slice(0, 20);
    sites.push({ name: name, url: url });
    saveSites();
    closeSheet();
    render();
    toast(name + " ajouté");
  });

  // ---------- Thème ----------
  var NAMES = { indigo: "Indigo", oled: "OLED", clair: "Clair" };
  $("theme-btn").addEventListener("click", function () {
    // theme.js change le thème au même clic ; on affiche le nouveau nom juste après.
    setTimeout(function () { if (window.__vtTheme) toast("Thème " + NAMES[window.__vtTheme.get()]); }, 0);
  });

  render();
})();
