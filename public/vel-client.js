// Script injecté dans chaque page proxifiée (servi tel quel, non bundlé).
// Réécrit à la volée les requêtes du JS du site et ajoute une barre de navigation.
(function () {
  "use strict";
  try {
    var CFG = window.__VEL || {};
    var BASE = CFG.base;
    var ORIGIN = location.origin;
    var nativeOpen = window.open ? window.open.bind(window) : null;

    function enc(url) {
      var bytes = new TextEncoder().encode(url);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function absolute(u) { try { return new URL(u, BASE).href; } catch (e) { return null; } }

    function proxied(u) {
      if (u == null) return u;
      u = String(u);
      if (!u) return u;
      if (/^(data|blob|javascript|about|mailto|tel|sms|ws|wss):/i.test(u)) return u;
      if (u.charAt(0) === "#") return u;
      if (u.indexOf(ORIGIN + "/p/") === 0 || u.indexOf("/p/") === 0) return u;
      var a = absolute(u);
      if (!a) return u;
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

    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") input = proxied(input);
          else if (input && input.url) input = new Request(proxied(input.url), input);
        } catch (e) {}
        return _fetch.call(this, input, init);
      };
    }

    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { arguments[1] = proxied(url); } catch (e) {}
      return _open.apply(this, arguments);
    };

    var _wopen = window.open;
    window.open = function (u, t, f) {
      try { u = proxied(u); } catch (e) {}
      return _wopen ? _wopen.call(window, u, t, f) : null;
    };

    if (navigator.sendBeacon) {
      var _beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, d) { try { u = proxied(u); } catch (e) {} return _beacon(u, d); };
    }

    var ATTRS = ["src", "href", "poster", "data-src", "data-href", "action", "formaction"];
    function fixEl(el) {
      if (!el || el.nodeType !== 1 || !el.getAttribute) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var a = ATTRS[i];
        if (el.hasAttribute(a)) {
          var v = el.getAttribute(a), p = proxied(v);
          if (p !== v) try { el.setAttribute(a, p); } catch (e) {}
        }
      }
      if (el.hasAttribute("srcset")) {
        var sv = el.getAttribute("srcset"), sp = proxiedSrcset(sv);
        if (sp !== sv) try { el.setAttribute("srcset", sp); } catch (e) {}
      }
    }
    function scan(root) {
      try {
        fixEl(root);
        if (root.querySelectorAll) {
          var f = root.querySelectorAll("[src],[href],[srcset],[action],[poster],[data-src],[formaction]");
          for (var i = 0; i < f.length; i++) fixEl(f[i]);
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
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS.concat(["srcset"]) });
    } catch (e) {}

    // ---------- Barre de navigation (Shadow DOM) ----------
    function resolveAddr(val) {
      if (/^https?:\/\//i.test(val)) return val;
      if (/^[^\s.]+\.[^\s]{2,}$/.test(val) && !/\s/.test(val)) return "https://" + val;
      return "https://duckduckgo.com/?q=" + encodeURIComponent(val);
    }
    function makeBar() {
      try {
        if (window.top !== window.self) return;
        if (document.getElementById("__velbar_host")) return;
        var host = document.createElement("div");
        host.id = "__velbar_host";
        host.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;";
        var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
        var ic = function (p, w) { return '<svg viewBox="0 0 24 24"' + (w ? ' style="width:14px;height:14px"' : '') + '>' + p + '</svg>'; };
        root.innerHTML =
          '<style>' +
          '.bar{display:flex;align-items:center;gap:3px;background:rgba(17,19,26,.93);backdrop-filter:blur(10px);' +
          'border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:5px;box-shadow:0 12px 32px -14px rgba(0,0,0,.75);font-family:system-ui,sans-serif;}' +
          'button,.lk{all:unset;box-sizing:border-box;display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;cursor:pointer;}' +
          'button:hover,.lk:hover{background:rgba(255,255,255,.12);}' +
          '.addr{display:flex;align-items:center;min-width:120px;max-width:44vw;height:30px;padding:0 10px;margin:0 3px;border-radius:8px;' +
          'background:rgba(255,255,255,.07);color:#cfd2dd;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text;}' +
          '.addr input{all:unset;box-sizing:border-box;width:44vw;color:#fff;font-size:12px;}' +
          'svg{width:16px;height:16px;fill:none;stroke:#cfd2dd;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}' +
          '.hidden{display:none!important;}' +
          '.handle{width:40px;height:16px;border-radius:0 0 10px 10px;background:rgba(17,19,26,.9);border:1px solid rgba(255,255,255,.14);border-top:0;display:grid;place-items:center;cursor:pointer;}' +
          '</style>' +
          '<div class="bar" id="vb-bar">' +
          '<button id="vb-b" title="Retour">' + ic('<path d="M15 6l-6 6 6 6"/>') + '</button>' +
          '<button id="vb-f" title="Page suivante">' + ic('<path d="M9 6l6 6-6 6"/>') + '</button>' +
          '<button id="vb-r" title="Recharger">' + ic('<path d="M20 11a8 8 0 1 0-1.3 4.4"/><path d="M20 4v7h-7"/>') + '</button>' +
          '<button id="vb-h" title="Accueil Vel-Tube">' + ic('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>') + '</button>' +
          '<div class="addr" id="vb-addr"></div>' +
          '<button id="vb-o" title="Ouvrir l\'original">' + ic('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6H5V5h6"/>') + '</button>' +
          '<button id="vb-x" title="Masquer">' + ic('<path d="M6 6l12 12M18 6L6 18"/>') + '</button>' +
          '</div>' +
          '<div class="handle hidden" id="vb-handle">' + ic('<path d="M6 9l6 6 6-6"/>', true) + '</div>';
        (document.body || document.documentElement).appendChild(host);

        var bar = root.querySelector(".bar");
        var addr = root.querySelector("#vb-addr");
        function renderAddr() { addr.textContent = BASE; }
        renderAddr();
        root.querySelector("#vb-b").onclick = function () { history.back(); };
        root.querySelector("#vb-f").onclick = function () { history.forward(); };
        root.querySelector("#vb-r").onclick = function () { location.reload(); };
        root.querySelector("#vb-h").onclick = function () { location.href = ORIGIN + "/"; };
        root.querySelector("#vb-o").onclick = function () { if (nativeOpen) nativeOpen(BASE, "_blank"); };
        root.querySelector("#vb-x").onclick = function () { bar.classList.add("hidden"); root.querySelector("#vb-handle").classList.remove("hidden"); };
        root.querySelector("#vb-handle").onclick = function () { bar.classList.remove("hidden"); root.querySelector("#vb-handle").classList.add("hidden"); };
        addr.onclick = function () {
          if (addr.querySelector("input")) return;
          var inp = document.createElement("input");
          inp.value = BASE; addr.textContent = ""; addr.appendChild(inp); inp.focus(); inp.select();
          inp.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { var v = inp.value.trim(); if (v) location.href = ORIGIN + "/p/" + enc(resolveAddr(v)); }
            else if (e.key === "Escape") renderAddr();
          });
          inp.addEventListener("blur", renderAddr);
        };
      } catch (e) {}
    }

    function boot() { scan(document.documentElement); makeBar(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  } catch (e) {}
})();
