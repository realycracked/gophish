// Script injecté dans chaque page proxifiée (servi tel quel, non bundlé).
// Réécrit à la volée les requêtes du JS du site et ajoute une barre de navigation.
(function () {
  "use strict";
  try {
    var CFG = window.__VEL || {};
    var ORIGIN = location.origin;
    var HOME = CFG.home || "";            // origine servie à la racine ("mode site"), sinon ""
    var nativeOpen = window.open ? window.open.bind(window) : null;

    function enc(url) {
      var bytes = new TextEncoder().encode(url);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function dec(code) {
      var s = code.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      var bin = atob(s), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }

    // URL réelle de la page courante (suit les changements d'adresse des web apps).
    function currentReal() {
      try {
        var p = location.pathname;
        if (p.indexOf("/w/") === 0) {
          var rest = p.slice(3), i = rest.indexOf("/");
          var origin = dec(i < 0 ? rest : rest.slice(0, i));
          return new URL(origin + (i < 0 ? "/" : rest.slice(i)) + location.search + location.hash).href;
        }
        if (HOME) {
          var q = location.search.replace(/([?&])__vts=1(&|$)/, function (m, a, b) { return b ? a : ""; });
          return new URL(HOME + p + q + location.hash).href;
        }
      } catch (e) {}
      return CFG.base || location.href;
    }
    // Site ouvert en "mode site", vu depuis n'importe quel cadre (une iframe /w/
    // le récupère auprès de la page principale).
    var TOPHOME = HOME || (function () { try { return (window.top.__VEL || {}).home || ""; } catch (e) { return ""; } })();

    // Adresse de notre domaine -> adresse réelle ("" pour nos propres pages).
    function realOfWorkerUrl(s) {
      try {
        var u = new URL(s);
        if (u.origin !== ORIGIN) return s;
        if (u.pathname.indexOf("/w/") === 0) {
          var rest = u.pathname.slice(3), i = rest.indexOf("/");
          return new URL(dec(i < 0 ? rest : rest.slice(0, i)) + (i < 0 ? "/" : rest.slice(i)) + u.search + u.hash).href;
        }
        if (u.pathname.indexOf("/__vt/") === 0 || u.pathname.indexOf("/p/") === 0) return "";
        if (TOPHOME) {
          var q = u.search.replace(/([?&])__vts=1(&|$)/, function (m, a, b) { return b ? a : ""; });
          return new URL(TOPHOME + u.pathname + q + u.hash).href;
        }
      } catch (e) {}
      return "";
    }

    // document.referrer : certains sites (portails de jeux…) vérifient qui les a
    // ouverts. On rend l'adresse réelle au lieu de la nôtre.
    try {
      var rd = Object.getOwnPropertyDescriptor(Document.prototype, "referrer");
      if (rd && rd.get) Object.defineProperty(Document.prototype, "referrer", {
        configurable: true, get: function () { var r = rd.get.call(this); return r ? realOfWorkerUrl(r) : r; }
      });
    } catch (e) {}

    window.__VEL_REAL = function () { try { return new URL(currentReal()).origin; } catch (e) { return ORIGIN; } };

    // Adresse réelle -> adresse dans le proxy (chemin racine pour le site ouvert,
    // /w/<origine>/<chemin> pour les autres domaines).
    function toProxy(abs) {
      var u = new URL(abs);
      if (u.protocol !== "http:" && u.protocol !== "https:") return abs;
      if (HOME && u.origin === HOME) return u.pathname + u.search + u.hash;
      return ORIGIN + "/w/" + enc(u.origin) + u.pathname + u.search + u.hash;
    }

    // Certains sites fabriquent leurs sous-domaines à partir de location.hostname
    // (ex. "api." + domaine) : "api.<notre domaine>" est rattaché au vrai site.
    var PARENT = /^\d+(\.\d+){3}$/.test(location.hostname) || location.hostname.split(".").length < 3 ? "" : location.hostname.split(".").slice(1).join(".");
    function siteParent() {
      try { var h = new URL(HOME || CFG.base).hostname.split("."); return h.length > 2 ? h.slice(1).join(".") : h.join("."); } catch (e) { return ""; }
    }
    function fixSibling(url) {
      if (PARENT && url.hostname !== location.hostname && url.hostname.slice(-PARENT.length - 1) === "." + PARENT) {
        var sp = siteParent();
        if (sp) url.hostname = url.hostname.slice(0, -PARENT.length - 1) + "." + sp;
      }
      return url;
    }

    function proxied(u) {
      if (u == null) return u;
      if (typeof u !== "string") { if (u instanceof URL) u = u.href; else return u; }
      if (!u) return u;
      if (/^(data|blob|javascript|about|mailto|tel|sms|ws|wss):/i.test(u)) return u;
      if (u.charAt(0) === "#") return u;
      var url;
      try { url = fixSibling(new URL(u, currentReal())); } catch (e) { return u; }
      if (url.origin === ORIGIN) {
        // Déjà une adresse du proxy ou de l'appli : on n'y touche pas.
        if (/^\/(w|p|__vt)\//.test(url.pathname)) return u;
        // Sinon le site a fabriqué l'adresse à partir de location.origin : en
        // mode site c'est déjà bon, ailleurs on la rattache au vrai domaine.
        if (HOME && /^\//.test(u)) return u;
        try { url = new URL(url.pathname + url.search + url.hash, currentReal()); } catch (e) { return u; }
      }
      try { return toProxy(url.href); } catch (e) { return u; }
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
          if (typeof input === "string" || input instanceof URL) input = proxied(String(input));
          else if (input && input.url) { var nu = proxied(input.url); if (nu !== input.url) input = new Request(nu, input); }
        } catch (e) {}
        return _fetch.call(this, input, init);
      };
    }

    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { arguments[1] = proxied(String(url)); } catch (e) {}
      return _open.apply(this, arguments);
    };

    var _wopen = window.open;
    window.open = function (u, t, f) {
      try { if (u) u = proxied(String(u)); } catch (e) {}
      return _wopen ? _wopen.call(window, u, t, f) : null;
    };

    if (navigator.sendBeacon) {
      var _beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, d) { try { u = proxied(String(u)); } catch (e) {} return _beacon(u, d); };
    }

    // WebSocket : wss://site/x -> wss://<proxy>/x (site ouvert) ou /w/<origine>/x.
    function wsProxied(u) {
      var x = fixSibling(new URL(String(u), currentReal().replace(/^http/, "ws")));
      if (x.host === location.host) return x.href;
      var origin = (x.protocol === "wss:" || x.protocol === "https:" ? "https:" : "http:") + "//" + x.host;
      var base = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
      if (HOME && origin === HOME) return base + x.pathname + x.search;
      return base + "/w/" + enc(origin) + x.pathname + x.search;
    }
    var _WS = window.WebSocket;
    if (_WS) {
      var PWS = function (url, protocols) {
        try { url = wsProxied(url); } catch (e) {}
        return protocols === undefined ? new _WS(url) : new _WS(url, protocols);
      };
      PWS.prototype = _WS.prototype;
      PWS.CONNECTING = 0; PWS.OPEN = 1; PWS.CLOSING = 2; PWS.CLOSED = 3;
      window.WebSocket = PWS;
    }

    // postMessage : toutes les pages proxifiées partagent notre domaine, donc un
    // message adressé à "https://jeu.com" serait jeté par le navigateur. On
    // l'envoie à "*", emballé avec l'origine réelle de l'expéditeur (retrouvée
    // d'après l'adresse du script appelant), et on le déballe à la réception.
    function realOriginOfScript(src) {
      var r = realOfWorkerUrl(src);
      try { return r ? new URL(r).origin : ""; } catch (e) { return ""; }
    }
    function senderOrigin() {
      try {
        var st = String(new Error().stack || ""), re = /(https?:\/\/[^\s()]+?):\d+:\d+/g, m;
        while ((m = re.exec(st))) {
          if (m[1].indexOf("/__vt/vel-client.js") >= 0) continue;
          var o = realOriginOfScript(m[1]);
          if (o) return o;
        }
      } catch (e) {}
      return "";
    }
    // Envoi : l'appel natif doit partir du cadre de l'expéditeur, sinon le
    // navigateur donne la page destinataire comme event.source et les réponses
    // via event.source.postMessage() se perdent. Chaque cadre expose donc son
    // postMessage natif et une fonction d'envoi exécutée dans son propre cadre.
    var _pm = window.postMessage;
    window.__vtNativePM = _pm;
    window.__vtSend = function (target, box, opts, transfer) {
      var native = target.__vtNativePM || _pm;
      if (opts) return Function.prototype.call.call(native, target, box, opts);
      return transfer === undefined ? Function.prototype.call.call(native, target, box, "*")
                                    : Function.prototype.call.call(native, target, box, "*", transfer);
    };
    function allWindows() {
      var out = [], queue = [];
      try { queue.push(window.top); } catch (e) {}
      while (queue.length && out.length < 200) {
        var w = queue.shift(); out.push(w);
        try { for (var i = 0; i < w.frames.length; i++) queue.push(w.frames[i]); } catch (e) {}
      }
      return out;
    }
    // Cadre expéditeur probable : un autre cadre proxifié dont l'origine réelle
    // correspond ; à défaut le destinataire lui-même (message à soi).
    function findSender(origin, target) {
      if (!origin) return null;
      var ws = allWindows();
      for (var i = 0; i < ws.length; i++) {
        try { if (ws[i] !== target && ws[i].__vtSend && ws[i].__VEL_REAL && ws[i].__VEL_REAL() === origin) return ws[i]; } catch (e) {}
      }
      try { if (target.__VEL_REAL && target.__VEL_REAL() === origin) return target; } catch (e) {}
      return null;
    }
    window.postMessage = function (msg, target, transfer) {
      var from = senderOrigin();
      var box = from ? { __vtBox: 1, o: from, d: msg } : msg;
      var opts = null;
      if (target && typeof target === "object") { opts = {}; for (var k in target) opts[k] = target[k]; opts.targetOrigin = "*"; }
      var sender = findSender(from, this);
      if (sender && sender.__vtSend) {
        try { return sender.__vtSend(this, box, opts, transfer); } catch (e) {}
      }
      if (opts) return _pm.call(this, box, opts);
      return transfer === undefined ? _pm.call(this, box, "*") : _pm.call(this, box, "*", transfer);
    };
    try {
      var dd = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
      var od = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "origin");
      var boxOf = function (ev) { var d = dd.get.call(ev); return d && typeof d === "object" && d.__vtBox === 1 ? d : null; };
      if (dd && dd.get) Object.defineProperty(MessageEvent.prototype, "data", {
        configurable: true, get: function () { var b = boxOf(this); return b ? b.d : dd.get.call(this); }
      });
      if (od && od.get) Object.defineProperty(MessageEvent.prototype, "origin", {
        configurable: true, get: function () { var b = boxOf(this); return b ? b.o : od.get.call(this); }
      });
    } catch (e) {}

    // Un service worker du site s'installerait sur tout notre domaine : refusé.
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.register) {
        navigator.serviceWorker.register = function () { return Promise.reject(new Error("Service workers désactivés par le proxy")); };
      }
    } catch (e) {}

    // Adresses posées en JavaScript : réécrites dès l'affectation (une image
    // commence à charger avant même d'être ajoutée à la page).
    function patchProp(Ctor, prop, fn) {
      try {
        if (!Ctor) return;
        var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
        if (!d || !d.set) return;
        Object.defineProperty(Ctor.prototype, prop, {
          configurable: true, enumerable: d.enumerable, get: d.get,
          set: function (v) { try { v = fn(String(v)); } catch (e) {} return d.set.call(this, v); }
        });
      } catch (e) {}
    }
    [[window.HTMLImageElement, "src"], [window.HTMLScriptElement, "src"], [window.HTMLIFrameElement, "src"],
     [window.HTMLSourceElement, "src"], [window.HTMLMediaElement, "src"], [window.HTMLEmbedElement, "src"],
     [window.HTMLTrackElement, "src"], [window.HTMLInputElement, "src"], [window.HTMLLinkElement, "href"],
     [window.HTMLFormElement, "action"]].forEach(function (p) { patchProp(p[0], p[1], proxied); });
    [[window.HTMLImageElement, "srcset"], [window.HTMLSourceElement, "srcset"]].forEach(function (p) { patchProp(p[0], p[1], proxiedSrcset); });
    var _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        var n = String(name).toLowerCase();
        if (n === "src" || n === "href" || n === "action" || n === "formaction" || n === "poster" || n === "data-src") value = proxied(String(value));
        else if (n === "srcset") value = proxiedSrcset(String(value));
      } catch (e) {}
      return _setAttr.call(this, name, value);
    };

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
      return "https://www.bing.com/search?q=" + encodeURIComponent(val) + "&setlang=fr";
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
        function renderAddr() { addr.textContent = currentReal(); }
        renderAddr();
        root.querySelector("#vb-b").onclick = function () { history.back(); };
        root.querySelector("#vb-f").onclick = function () { history.forward(); };
        root.querySelector("#vb-r").onclick = function () { location.reload(); };
        root.querySelector("#vb-h").onclick = function () { location.href = ORIGIN + "/__vt/"; };
        root.querySelector("#vb-o").onclick = function () { if (nativeOpen) nativeOpen(currentReal(), "_blank"); };
        root.querySelector("#vb-x").onclick = function () { bar.classList.add("hidden"); root.querySelector("#vb-handle").classList.remove("hidden"); };
        root.querySelector("#vb-handle").onclick = function () { bar.classList.remove("hidden"); root.querySelector("#vb-handle").classList.add("hidden"); };
        addr.onclick = function () {
          if (addr.querySelector("input")) return;
          var inp = document.createElement("input");
          inp.value = currentReal(); addr.textContent = ""; addr.appendChild(inp); inp.focus(); inp.select();
          inp.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { var v = inp.value.trim(); if (v) location.href = ORIGIN + "/w/" + enc(new URL(resolveAddr(v)).origin) + new URL(resolveAddr(v)).pathname + new URL(resolveAddr(v)).search; }
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
