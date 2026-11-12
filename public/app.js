// Interface Vél·Proxy — accueil
(function () {
  "use strict";

  // Encodage identique au serveur (src/codec.js).
  function enc(url) {
    var bytes = new TextEncoder().encode(url);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function open(url) {
    window.location.href = "/p/" + enc(url);
  }

  // Décide si l'entrée est une URL ou une recherche.
  function resolveQuery(raw) {
    var q = raw.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    // "domaine.tld" éventuellement avec chemin, sans espace -> URL
    if (/^[^\s.]+\.[^\s]{2,}$/.test(q) && !/\s/.test(q)) {
      return "https://" + q;
    }
    return "https://duckduckgo.com/?q=" + encodeURIComponent(q);
  }

  var form = document.getElementById("omni");
  var input = document.getElementById("omni-input");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = resolveQuery(input.value);
    if (url) open(url);
  });

  // Boutons/chips avec data-go
  document.querySelectorAll("[data-go]").forEach(function (el) {
    el.addEventListener("click", function () { open(el.getAttribute("data-go")); });
  });

  // Catalogue de jeux
  var TONES = ["#7c5cff", "#38e8ff", "#ff5cc8", "#5cff9e", "#ffb85c"];
  var grid = document.getElementById("grid");
  var filter = document.getElementById("filter");
  var games = [];
  var active = "Tous";

  function render() {
    grid.innerHTML = "";
    var list = active === "Tous" ? games : games.filter(function (g) { return g.cat === active; });
    list.forEach(function (g, i) {
      var b = document.createElement("button");
      b.className = "tile";
      b.style.setProperty("--tc", TONES[i % TONES.length]);
      b.innerHTML =
        '<span class="glow"></span>' +
        '<span class="nm"></span>' +
        '<span class="cat"></span>';
      b.querySelector(".nm").textContent = g.name;
      b.querySelector(".cat").textContent = g.cat;
      b.addEventListener("click", function () { open(g.url); });
      grid.appendChild(b);
    });
  }

  function buildFilter() {
    var cats = ["Tous"];
    games.forEach(function (g) { if (cats.indexOf(g.cat) === -1) cats.push(g.cat); });
    filter.innerHTML = "";
    cats.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "fbtn";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(c === active));
      b.textContent = c;
      b.addEventListener("click", function () {
        active = c;
        filter.querySelectorAll(".fbtn").forEach(function (x) {
          x.setAttribute("aria-selected", String(x.textContent === c));
        });
        render();
      });
      filter.appendChild(b);
    });
  }

  fetch("/games.json")
    .then(function (r) { return r.json(); })
    .then(function (data) { games = data; buildFilter(); render(); })
    .catch(function () {
      grid.innerHTML = '<p class="disclaimer">Impossible de charger la liste des jeux.</p>';
    });
})();
