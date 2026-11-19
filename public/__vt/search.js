// Page de résultats : appelle /__vt/api/search et ouvre les liens via le proxy.
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  function enc(url) {
    var bytes = new TextEncoder().encode(url), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function viaProxy(url) {
    try { var u = new URL(url); return "/w/" + enc(u.origin) + u.pathname + u.search + u.hash; } catch (e) { return "#"; }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var q = "", type = "web", page = 0, seq = 0;
  var params = new URLSearchParams(location.search);
  q = (params.get("q") || "").trim();
  type = params.get("type") === "images" ? "images" : "web";
  $("q").value = q;

  function setUrl() {
    history.replaceState(null, "", "/__vt/search?q=" + encodeURIComponent(q) + (type === "images" ? "&type=images" : ""));
    document.title = (q ? q + " · " : "") + "Recherche";
  }
  function markTab() {
    document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-t") === type); });
  }

  function clear() {
    $("results").innerHTML = ""; $("grid").innerHTML = ""; $("strip").innerHTML = ""; $("wiki").innerHTML = "";
    $("wiki").hidden = true; $("strip").hidden = true; $("grid").hidden = type !== "images"; $("more").hidden = true;
  }

  function load(append) {
    if (!q) { $("status").textContent = ""; return; }
    var my = ++seq;
    if (!append) { page = 0; clear(); }
    $("status").textContent = "Recherche…";
    $("more").hidden = true;
    fetch("/__vt/api/search?q=" + encodeURIComponent(q) + "&type=" + type + "&page=" + page)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (my !== seq) return;
        $("status").textContent = "";
        if (type === "images") renderGrid(d.images || []);
        else renderWeb(d);
      })
      .catch(function () { if (my === seq) $("status").textContent = "La recherche a échoué. Réessaie."; });
  }

  function renderWeb(d) {
    if (d.wiki && page === 0) {
      var w = $("wiki");
      if (d.wiki.image) { var im = el("img"); im.src = viaProxy(d.wiki.image); im.alt = ""; im.loading = "lazy"; w.appendChild(im); }
      var box = el("div");
      box.appendChild(el("h2", null, d.wiki.title));
      if (d.wiki.description) box.appendChild(el("div", "desc", d.wiki.description));
      box.appendChild(el("p", null, d.wiki.extract));
      var a = el("a", "src", "Wikipédia ›"); a.href = viaProxy(d.wiki.url); box.appendChild(a);
      w.appendChild(box); w.hidden = false;
    }
    if (d.images && d.images.length && page === 0) {
      var s = $("strip");
      d.images.forEach(function (img) { s.appendChild(thumb(img)); });
      var all = el("button", "all", "Toutes les images ›"); all.type = "button";
      all.addEventListener("click", function () { switchTab("images"); });
      s.appendChild(all);
      s.hidden = false;
    }
    var ol = $("results");
    (d.results || []).forEach(function (r) {
      var li = el("li", "r");
      var a = el("a"); a.href = viaProxy(r.url);
      var site = el("div", "site");
      var fav = el("img"); fav.alt = ""; fav.loading = "lazy"; fav.src = "/__vt/icon?u=" + encodeURIComponent(r.url);
      fav.onerror = function () { fav.remove(); };
      site.appendChild(fav); site.appendChild(el("span", null, r.site));
      a.appendChild(site); a.appendChild(el("h3", null, r.title));
      li.appendChild(a);
      if (r.snippet) li.appendChild(el("p", null, r.snippet));
      ol.appendChild(li);
    });
    if (!ol.children.length) $("status").textContent = "Aucun résultat.";
    else $("more").hidden = (d.results || []).length < 5;
  }

  function thumb(img) {
    var b = el("button"); b.type = "button"; b.title = img.title || "";
    var i = el("img"); i.alt = img.title || ""; i.loading = "lazy"; i.src = viaProxy(img.thumb);
    i.onerror = function () { b.remove(); };
    b.appendChild(i);
    b.addEventListener("click", function () { openLb(img); });
    return b;
  }
  function renderGrid(list) {
    var g = $("grid"); g.hidden = false;
    list.forEach(function (img) { g.appendChild(thumb(img)); });
    if (!g.children.length) $("status").textContent = "Aucune image.";
    $("more").hidden = list.length < 20;
  }

  // Visionneuse d'image
  function openLb(img) {
    var lbi = $("lb-img");
    lbi.src = viaProxy(img.thumb);
    var full = new Image();
    full.onload = function () { lbi.src = full.src; };
    full.src = viaProxy(img.img);
    $("lb-title").textContent = img.title || "";
    $("lb-page").href = viaProxy(img.page);
    $("lb").hidden = false;
  }
  function closeLb() { $("lb").hidden = true; $("lb-img").removeAttribute("src"); }
  $("lb-close").addEventListener("click", closeLb);
  $("lb").addEventListener("click", function (e) { if (e.target === $("lb")) closeLb(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLb(); });

  function switchTab(t) { type = t; markTab(); setUrl(); load(false); window.scrollTo(0, 0); }
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () { if (b.getAttribute("data-t") !== type) switchTab(b.getAttribute("data-t")); });
  });
  $("more").addEventListener("click", function () { page++; load(true); });

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("q").value.trim();
    if (!v) return;
    // Une adresse tapée ici ouvre directement le site.
    if (/^https?:\/\//i.test(v) || (/^[^\s.]+\.[a-z]{2,}(\/\S*)?$/i.test(v))) {
      location.href = viaProxy(/^https?:/i.test(v) ? v : "https://" + v);
      return;
    }
    q = v; setUrl(); load(false); $("q").blur();
  });

  markTab(); setUrl();
  if (q) load(false); else $("q").focus();
})();
