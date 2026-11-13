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

  // ---------- Sites favoris perso (gardés sur l'appareil) ----------
  var DEFAULT_SITES = [
    { name: "Reddit", url: "https://www.reddit.com" },
    { name: "DuckDuckGo", url: "https://duckduckgo.com" },
    { name: "Wikipédia", url: "https://www.wikipedia.org" }
  ];
  function loadSites() {
    try { var s = JSON.parse(localStorage.getItem("vt_sites")); if (Array.isArray(s)) return s; } catch (e) {}
    return DEFAULT_SITES.slice();
  }
  function saveSites() { try { localStorage.setItem("vt_sites", JSON.stringify(sites)); } catch (e) {} }

  var sites = loadSites();
  var editing = false;
  var box = document.getElementById("sites");
  var form = document.getElementById("site-form");
  var nameIn = document.getElementById("site-name");
  var urlIn = document.getElementById("site-url");

  function chip(label, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "chip " + (cls || ""); b.textContent = label;
    b.addEventListener("click", onClick);
    box.appendChild(b);
    return b;
  }
  function renderSites() {
    box.innerHTML = "";
    sites.forEach(function (s, i) {
      var b = chip(editing ? s.name + "  ✕" : s.name, editing ? "chip-del" : "", function () {
        if (editing) { sites.splice(i, 1); saveSites(); renderSites(); }
        else openProxy(s.url);
      });
      b.title = editing ? "Retirer " + s.name : s.url;
    });
    if (!editing) chip("+ Ajouter", "chip-ghost", function () {
      form.hidden = false; nameIn.focus();
    });
    if (sites.length) chip(editing ? "Terminé" : "Modifier", "chip-ghost", function () {
      editing = !editing; form.hidden = true; renderSites();
    });
  }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = resolveQuery(urlIn.value);
    if (!url || /duckduckgo\.com\/\?q=/.test(url) && !/^https?:/i.test(urlIn.value.trim())) {
      urlIn.focus(); urlIn.setCustomValidity("Entre une adresse, par ex. twitch.tv"); urlIn.reportValidity();
      return;
    }
    var name = nameIn.value.trim();
    if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ""); } catch (err) { name = url; } }
    sites.push({ name: name.slice(0, 30), url: url });
    saveSites();
    nameIn.value = ""; urlIn.value = ""; form.hidden = true;
    renderSites();
  });
  urlIn.addEventListener("input", function () { urlIn.setCustomValidity(""); });
  renderSites();
})();
