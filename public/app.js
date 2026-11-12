// Accueil Vél·Tube : recherche YouTube (vers le lecteur) + ouverture d'un site via le proxy.
(function () {
  "use strict";

  function enc(url) {
    var bytes = new TextEncoder().encode(url);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function openProxy(url) { window.location.href = "/p/" + enc(url); }
  function openYouTube(q) { window.location.href = "/youtube?q=" + encodeURIComponent(q); }

  function resolveQuery(raw) {
    var q = raw.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (/^[^\s.]+\.[^\s]{2,}$/.test(q) && !/\s/.test(q)) return "https://" + q;
    return "https://duckduckgo.com/?q=" + encodeURIComponent(q);
  }

  // Recherche YouTube
  var yt = document.getElementById("yt");
  var ytInput = document.getElementById("yt-input");
  yt.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = ytInput.value.trim();
    if (q) openYouTube(q);
  });
  document.querySelectorAll("[data-yt]").forEach(function (el) {
    el.addEventListener("click", function () { openYouTube(el.getAttribute("data-yt")); });
  });

  // Proxy : ouvrir un site
  var omni = document.getElementById("omni");
  var omniInput = document.getElementById("omni-input");
  omni.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = resolveQuery(omniInput.value);
    if (url) openProxy(url);
  });
  document.querySelectorAll("[data-go]").forEach(function (el) {
    el.addEventListener("click", function () { openProxy(el.getAttribute("data-go")); });
  });
})();
