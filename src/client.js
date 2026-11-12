// Script injecté dans chaque page proxifiée.
// Il réécrit à la volée les requêtes construites par le JavaScript du site
// (fetch, XHR, nouveaux éléments, window.open) pour qu'elles repassent par /p/.
// On l'écrit comme une vraie fonction puis on la sérialise (voir clientSource()).

function velClient() {
  "use strict";
  try {
    var CFG = window.__VEL || {};
    var BASE = CFG.base;            // URL réelle de la page proxifiée
    var ORIGIN = location.origin;   // origine du Worker

    // --- encodage identique au serveur ---
    function enc(url) {
      var bytes = new TextEncoder().encode(url);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function absolute(u) {
      try { return new URL(u, BASE).href; } catch (e) { return null; }
    }

    // Transforme une URL quelconque en URL proxifiée.
    function proxied(u) {
      if (u == null) return u;
      u = String(u);
      if (!u) return u;
      if (/^(data|blob|javascript|about|mailto|tel|sms|ws|wss):/i.test(u)) return u;
      if (u.charAt(0) === "#") return u;
      if (u.indexOf(ORIGIN + "/p/") === 0 || u.indexOf("/p/") === 0) return u;

      var a = absolute(u);
      if (!a) return u;

      // Récupère les requêtes que le site envoie vers l'origine du Worker
      // par confusion (location.origin + "/api"), en les rattachant au vrai site.
      try {
        var url = new URL(a);
        if (url.origin === ORIGIN) {
          if (url.pathname.indexOf("/p/") === 0) return a;
          a = new URL(url.pathname + url.search + url.hash, BASE).href;
        }
      } catch (e) {}

      return ORIGIN + "/p/" + enc(a);
    }

    function proxiedSrcset(v) {
      try {
        return v.split(",").map(function (part) {
          var seg = part.trim();
          if (!seg) return part;
          var sp = seg.split(/\s+/);
          sp[0] = proxied(sp[0]);
          return sp.join(" ");
        }).join(", ");
      } catch (e) { return v; }
    }

    // --- fetch ---
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") {
            input = proxied(input);
          } else if (input && input.url) {
            input = new Request(proxied(input.url), input);
          }
        } catch (e) {}
        return _fetch.call(this, input, init);
      };
    }

    // --- XMLHttpRequest ---
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { arguments[1] = proxied(url); } catch (e) {}
      return _open.apply(this, arguments);
    };

    // --- window.open ---
    var _wopen = window.open;
    window.open = function (u, t, f) {
      try { u = proxied(u); } catch (e) {}
      return _wopen ? _wopen.call(window, u, t, f) : null;
    };

    // --- sendBeacon ---
    if (navigator.sendBeacon) {
      var _beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, d) {
        try { u = proxied(u); } catch (e) {}
        return _beacon(u, d);
      };
    }

    // --- éléments ajoutés / attributs modifiés ---
    var ATTRS = ["src", "href", "poster", "data-src", "data-href", "action", "formaction"];
    function fixEl(el) {
      if (!el || el.nodeType !== 1 || !el.getAttribute) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var a = ATTRS[i];
        if (el.hasAttribute(a)) {
          var v = el.getAttribute(a);
          var p = proxied(v);
          if (p !== v) try { el.setAttribute(a, p); } catch (e) {}
        }
      }
      if (el.hasAttribute("srcset")) {
        var sv = el.getAttribute("srcset");
        var sp = proxiedSrcset(sv);
        if (sp !== sv) try { el.setAttribute("srcset", sp); } catch (e) {}
      }
    }

    function scan(root) {
      try {
        fixEl(root);
        if (root.querySelectorAll) {
          var found = root.querySelectorAll("[src],[href],[srcset],[action],[poster],[data-src],[formaction]");
          for (var i = 0; i < found.length; i++) fixEl(found[i]);
        }
      } catch (e) {}
    }

    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "attributes") { fixEl(m.target); continue; }
          if (m.addedNodes) for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
        }
      });
      mo.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ATTRS.concat(["srcset"])
      });
    } catch (e) {}

    // Premier passage dès que le DOM est prêt.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { scan(document.documentElement); });
    } else {
      scan(document.documentElement);
    }
  } catch (e) {}
}

export function clientSource() {
  return "(" + velClient.toString() + ")();";
}
