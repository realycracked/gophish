// Sélecteur de thème partagé (Indigo / OLED / Clair), mémorisé sur l'appareil.
(function () {
  "use strict";
  var THEMES = {
    indigo: { bg: "#0d0e1a", surface: "#161828", "surface-2": "#20233c", fg: "#eef0ff", muted: "#a2a4c8", line: "rgba(255,255,255,.10)", "line-2": "rgba(255,255,255,.06)", accent: "#8b7bff", blue: "#3f8bff" },
    oled:   { bg: "#000000", surface: "#0b0b0d", "surface-2": "#17171a", fg: "#f5f5f7", muted: "#9a9aa2", line: "rgba(255,255,255,.13)", "line-2": "rgba(255,255,255,.07)", accent: "#8b7bff", blue: "#4f8bff" },
    clair:  { bg: "#f5f7fb", surface: "#ffffff", "surface-2": "#eceff5", fg: "#141922", muted: "#5c6675", line: "rgba(0,0,0,.10)", "line-2": "rgba(0,0,0,.06)", accent: "#6d5efc", blue: "#2f6bff" }
  };
  var NAMES = { indigo: "Indigo", oled: "OLED", clair: "Clair" };
  var ORDER = ["indigo", "oled", "clair"];

  function get() { try { return localStorage.getItem("vt_theme") || "indigo"; } catch (e) { return "indigo"; } }
  function set(v) { try { localStorage.setItem("vt_theme", v); } catch (e) {} }

  function apply(name) {
    var t = THEMES[name] || THEMES.indigo, r = document.documentElement;
    for (var k in t) r.style.setProperty("--" + k, t[k]);
    r.style.setProperty("color-scheme", name === "clair" ? "light" : "dark");
    r.setAttribute("data-vt-theme", name);
    var lbl = document.getElementById("theme-lbl");
    if (lbl) lbl.textContent = NAMES[name];
  }
  function cycle() {
    var i = (ORDER.indexOf(get()) + 1) % ORDER.length, nx = ORDER[i];
    set(nx); apply(nx);
  }

  window.__vtTheme = { apply: apply, get: get, cycle: cycle };
  apply(get());
  document.addEventListener("DOMContentLoaded", function () {
    apply(get());
    var btn = document.getElementById("theme-btn");
    if (btn) btn.addEventListener("click", cycle);
  });
})();
