// Échecs en ligne, sans proxy.
// - ChessRoom : une partie = un Durable Object nommé par son code (coups vérifiés
//   avec chess.js, pendules, nulle, abandon, partie annulée si personne ne joue).
// - ChessLobby : un seul Durable Object pour les profils (pseudo, Elo, bilan),
//   le matchmaking par cadence et le classement.
import { Chess } from "chess.js";

export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Cadences : [minutes, incrément en secondes]
// ("inf" : sans pendule, mais 10 minutes au plus par coup.)
export const TCS = { "1+0": [1, 0], "3+0": [3, 0], "3+2": [3, 2], "5+0": [5, 0], "10+0": [10, 0], "15+10": [15, 10], inf: [0, 0] };
const START_RATING = 1200;
const ABORT_MS = 45_000;          // partie classée : délai pour jouer son premier coup
const FORGET_MS = 30 * 86400e3;   // partie oubliée après 30 jours sans activité
const IDLE_MS = 10 * 60_000;      // partie classée sans pendule : 10 min au plus par coup

function newCode() {
  const a = new Uint32Array(5); crypto.getRandomValues(a);
  return Array.from(a, (n) => ALPHABET[n % ALPHABET.length]).join("");
}
export function cleanName(n) {
  const s = String(n || "").replace(/[^\p{L}\p{N}_ .-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s.length >= 2 ? s : null;
}
function parseTc(s) {
  const t = TCS[s];
  return t ? { id: s, base: t[0] * 60_000, inc: t[1] * 1000, untimed: t[0] === 0 } : null;
}
const other = (c) => (c === "w" ? "b" : "w");
const pidOf = (url) => (url.searchParams.get("p") || "").slice(0, 40);

// Routes /__vt/chess/ws (une partie) et /__vt/chess/lobby (accueil en ligne).
export function chessRoute(request, url, env) {
  if (request.headers.get("upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
  if (!env.CHESS || !env.LOBBY) return new Response("Échecs indisponibles", { status: 503 });
  if (!pidOf(url)) return new Response("Joueur inconnu", { status: 400 });
  if (url.pathname.endsWith("/lobby")) return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(request);
  const code = (url.searchParams.get("c") || "").toUpperCase();
  if (!CODE_RE.test(code)) return new Response("Code invalide", { status: 400 });
  return env.CHESS.get(env.CHESS.idFromName(code)).fetch(request);
}

// =====================================================================
// Une partie
// =====================================================================
export class ChessRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async load() { return (await this.ctx.storage.get("game")) || null; }
  async save(g) { await this.ctx.storage.put("game", g); }

  newGame(fields) {
    const tc = fields.tc || null;
    return {
      w: null, b: null, names: {}, tc, rated: false,
      moves: [], result: null, drawOffer: null, ratingChange: null,
      clock: tc && !tc.untimed ? { w: tc.base, b: tc.base, running: null, at: 0 } : null,
      created: Date.now(), last: Date.now(),
      ...fields,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Partie classée créée par le matchmaking.
    if (request.method === "POST" && url.pathname === "/init") {
      const d = await request.json();
      const g = this.newGame({ w: d.w, b: d.b, names: d.names, tc: parseTc(d.tc), rated: true });
      await this.save(g);
      await this.schedule(g);
      return new Response("ok");
    }

    const pid = pidOf(url);
    let g = await this.load();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [pid]);

    if (!g) {
      if (url.searchParams.get("join") === "1") {
        server.send(JSON.stringify({ t: "error", msg: "Partie introuvable. Vérifie le code." }));
        server.close(4004, "introuvable");
        return new Response(null, { status: 101, webSocket: client });
      }
      g = this.newGame({ w: pid, tc: parseTc(url.searchParams.get("tc")) });
    } else if (!g.rated && g.w !== pid && g.b !== pid) {
      if (!g.w) g.w = pid;
      else if (!g.b) g.b = pid;
    }
    if (!g.rated && (pid === g.w || pid === g.b)) {
      const n = cleanName(url.searchParams.get("n"));
      if (n) g.names[pid] = { name: n };
    }
    await this.save(g);
    await this.schedule(g);
    this.broadcast(g);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Une seule alarme : fin de temps, annulation, ou oubli de la partie.
  async schedule(g) {
    let at;
    if (!g.result && g.clock && g.clock.running) at = g.clock.at + g.clock[g.clock.running] + 50;
    else if (!g.result && g.rated && g.moves.length < 2) at = g.last + ABORT_MS;
    else if (!g.result && g.rated && !g.clock) at = g.last + IDLE_MS;
    else at = g.last + FORGET_MS;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const g = await this.load();
    if (!g) return;
    const now = Date.now();
    if (!g.result && this.checkFlag(g, now)) {
      await this.finish(g);
    } else if (!g.result && g.rated && g.moves.length < 2 && now >= g.last + ABORT_MS) {
      g.result = { winner: null, reason: "partie annulée", aborted: true };
    } else if (!g.result && g.rated && !g.clock && now >= g.last + IDLE_MS) {
      // Sans pendule : le joueur au trait qui ne joue plus perd.
      const turn = g.moves.length % 2 === 0 ? "w" : "b";
      g.result = { winner: other(turn), reason: "inactivité (10 min sans jouer)" };
      await this.finish(g);
    } else if (g.result && now >= g.last + FORGET_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.save(g);
    await this.schedule(g);
    this.broadcast(g);
  }

  // Temps écoulé pour le joueur au trait ?
  checkFlag(g, now) {
    const c = g.clock;
    if (!c || !c.running) return false;
    if (now - c.at < c[c.running]) return false;
    const loser = c.running;
    c[loser] = 0; c.running = null;
    // Sans matériel pour mater, l'adversaire ne peut pas gagner au temps.
    const chess = replay(g.moves);
    const mat = chess.board().flat().filter((p) => p && p.color === other(loser) && p.type !== "k");
    const cantMate = mat.length === 0 || (mat.length === 1 && (mat[0].type === "n" || mat[0].type === "b"));
    g.result = cantMate ? { winner: null, reason: "temps écoulé (matériel insuffisant)" } : { winner: other(loser), reason: "temps écoulé" };
    return true;
  }

  // Fin de partie classée : mise à jour de l'Elo par le lobby.
  async finish(g) {
    g.drawOffer = null;
    if (g.clock) g.clock.running = null;
    if (!g.rated || !g.result || g.result.aborted || g.ratingChange) return;
    const score = g.result.winner === "w" ? 1 : g.result.winner === "b" ? 0 : 0.5;
    try {
      const r = await this.env.LOBBY.get(this.env.LOBBY.idFromName("main")).fetch("https://lobby/result", {
        method: "POST", body: JSON.stringify({ w: g.w, b: g.b, score }),
      });
      g.ratingChange = await r.json();
    } catch {}
  }

  online() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === 1) for (const t of this.ctx.getTags(ws)) ids.add(t);
    }
    return ids;
  }

  view(g, pid, on) {
    const now = Date.now();
    let clock = null;
    if (g.clock) {
      clock = { w: g.clock.w, b: g.clock.b, running: g.clock.running };
      if (clock.running) clock[clock.running] = Math.max(0, clock[clock.running] - (now - g.clock.at));
    }
    const info = (id) => (id ? { name: (g.names[id] && g.names[id].name) || "Invité", rating: g.names[id] && g.names[id].rating } : null);
    return JSON.stringify({
      t: "state",
      you: g.w === pid ? "w" : g.b === pid ? "b" : "s",
      moves: g.moves,
      result: g.result,
      players: { w: !!g.w && on.has(g.w), b: !!g.b && on.has(g.b), bJoined: !!g.b },
      names: { w: info(g.w), b: info(g.b) },
      tc: g.tc && g.tc.id, rated: !!g.rated, clock, drawOffer: g.drawOffer, ratingChange: g.ratingChange,
      abortAt: g.rated && !g.result && g.moves.length < 2 ? g.last + ABORT_MS - now : null,
      idleLeft: g.rated && !g.clock && !g.result && g.moves.length >= 2 ? g.last + IDLE_MS - now : null,
    });
  }

  broadcast(g, skip) {
    const on = this.online();
    if (skip) for (const t of this.ctx.getTags(skip)) on.delete(t);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      try { ws.send(this.view(g, this.ctx.getTags(ws)[0], on)); } catch {}
    }
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    let g = await this.load();
    if (!g) return;
    const pid = this.ctx.getTags(ws)[0];
    const color = g.w === pid ? "w" : g.b === pid ? "b" : null;
    const now = Date.now();

    if (m.t === "move") {
      if (!color || g.result || !g.b) return this.resend(ws, g, pid);
      if (this.checkFlag(g, now)) { await this.finish(g); return this.commit(g); }
      const chess = replay(g.moves);
      if (chess.turn() !== color) return this.resend(ws, g, pid);
      let mv;
      try { mv = chess.move({ from: m.from, to: m.to, promotion: m.promotion || "q" }); } catch { mv = null; }
      if (!mv) return this.resend(ws, g, pid);
      g.moves.push(mv.san);
      g.drawOffer = null;
      g.last = now;
      if (g.clock) {
        if (g.clock.running === color) g.clock[color] = g.clock[color] - (now - g.clock.at) + g.tc.inc;
        // Les pendules démarrent après le premier coup de chaque joueur.
        if (g.moves.length >= 2) { g.clock.running = other(color); g.clock.at = now; }
      }
      g.result = outcome(chess);
      if (g.result) await this.finish(g);
    } else if (m.t === "flag") {
      if (g.result || !this.checkFlag(g, now)) return this.resend(ws, g, pid);
      await this.finish(g);
    } else if (m.t === "resign") {
      if (!color || g.result) return;
      g.result = g.rated && g.moves.length < 2
        ? { winner: null, reason: "partie annulée", aborted: true }
        : { winner: other(color), reason: "abandon" };
      g.last = now;
      await this.finish(g);
    } else if (m.t === "draw") {
      if (!color || g.result || g.moves.length < 2) return;
      if (g.drawOffer && g.drawOffer !== color) {
        g.result = { winner: null, reason: "nulle par accord" };
        g.last = now;
        await this.finish(g);
      } else g.drawOffer = color;
    } else if (m.t === "decline") {
      if (!color || g.drawOffer !== other(color)) return;
      g.drawOffer = null;
    } else if (m.t === "rematch") {
      if (!color || !g.result || g.rated) return;
      g = this.newGame({ w: g.b, b: g.w, names: g.names, tc: g.tc });
    } else {
      return; // ping
    }
    return this.commit(g);
  }

  async commit(g) {
    await this.save(g);
    await this.schedule(g);
    this.broadcast(g);
  }

  resend(ws, g, pid) {
    try { ws.send(this.view(g, pid, this.online())); } catch {}
  }

  async webSocketClose(ws) {
    const g = await this.load();
    if (g) this.broadcast(g, ws);
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}

function replay(moves) {
  const c = new Chess();
  for (const san of moves) c.move(san);
  return c;
}

function outcome(c) {
  if (c.isCheckmate()) return { winner: c.turn() === "w" ? "b" : "w", reason: "échec et mat" };
  if (c.isStalemate()) return { winner: null, reason: "pat" };
  if (c.isInsufficientMaterial()) return { winner: null, reason: "matériel insuffisant" };
  if (c.isThreefoldRepetition()) return { winner: null, reason: "répétition" };
  if (c.isDraw()) return { winner: null, reason: "règle des 50 coups" };
  return null;
}

// =====================================================================
// Lobby : profils, Elo, matchmaking, classement
// =====================================================================
export function eloUpdate(ra, rb, score, ga, gb) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const ka = ga < 30 ? 40 : 20, kb = gb < 30 ? 40 : 20;
  return [Math.round(ra + ka * (score - ea)), Math.round(rb + kb * (1 - score - (1 - ea)))];
}

export class ChessLobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async profile(pid) {
    let p = await this.ctx.storage.get("p:" + pid);
    if (!p) {
      p = { name: "Joueur" + Math.floor(1000 + Math.random() * 9000), rating: START_RATING, games: 0, w: 0, d: 0, l: 0, created: Date.now() };
      await this.ctx.storage.put("p:" + pid, p);
    }
    return p;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/result") {
      const { w, b, score } = await request.json();
      const pw = await this.profile(w), pb = await this.profile(b);
      const [nw, nb] = eloUpdate(pw.rating, pb.rating, score, pw.games, pb.games);
      const change = { w: { before: pw.rating, after: nw }, b: { before: pb.rating, after: nb } };
      pw.rating = nw; pb.rating = nb; pw.games++; pb.games++;
      if (score === 1) { pw.w++; pb.l++; } else if (score === 0) { pw.l++; pb.w++; } else { pw.d++; pb.d++; }
      await this.ctx.storage.put({ ["p:" + w]: pw, ["p:" + b]: pb });
      // Profils à jour pour les joueurs connectés au lobby.
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() || {};
        if (a.pid === w || a.pid === b) this.sendMe(ws, a.pid === w ? pw : pb);
      }
      return Response.json(change);
    }

    const pid = pidOf(url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid, seek: null });
    this.sendMe(server, await this.profile(pid));
    this.stats();
    return new Response(null, { status: 101, webSocket: client });
  }

  sendMe(ws, p) {
    try { ws.send(JSON.stringify({ t: "me", profile: p })); } catch {}
  }

  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1);
  }

  stats() {
    const pids = new Set(), seeking = {};
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() || {};
      pids.add(a.pid);
      if (a.seek) seeking[a.seek.tc] = (seeking[a.seek.tc] || 0) + 1;
    }
    const msg = JSON.stringify({ t: "stats", online: pids.size, seeking });
    for (const ws of this.sockets()) { try { ws.send(msg); } catch {} }
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (!a.pid) return;

    if (m.t === "name") {
      const n = cleanName(m.name);
      const p = await this.profile(a.pid);
      if (!n) { ws.send(JSON.stringify({ t: "error", msg: "Pseudo : 2 à 16 lettres ou chiffres." })); return this.sendMe(ws, p); }
      p.name = n;
      await this.ctx.storage.put("p:" + a.pid, p);
      return this.sendMe(ws, p);
    }
    if (m.t === "top") {
      const all = await this.ctx.storage.list({ prefix: "p:" });
      const list = [...all.entries()]
        .filter(([, p]) => p.games > 0)
        .sort((x, y) => y[1].rating - x[1].rating)
        .slice(0, 20)
        .map(([k, p]) => ({ name: p.name, rating: p.rating, games: p.games, me: k === "p:" + a.pid }));
      return ws.send(JSON.stringify({ t: "top", list }));
    }
    if (m.t === "seek") {
      if (!TCS[m.tc]) return;
      const p = await this.profile(a.pid);
      // Une seule recherche par joueur, même avec plusieurs onglets.
      for (const o of this.sockets()) {
        const oa = o.deserializeAttachment() || {};
        if (oa.pid === a.pid && oa.seek) o.serializeAttachment({ ...oa, seek: null });
      }
      a.seek = { tc: m.tc, rating: p.rating, name: p.name, since: Date.now() };
      ws.serializeAttachment(a);
      await this.pair(ws, a);
      return this.stats();
    }
    if (m.t === "cancel") {
      ws.serializeAttachment({ ...a, seek: null });
      return this.stats();
    }
  }

  // Associe le joueur au partenaire de même cadence le plus proche en Elo.
  async pair(ws, a) {
    let best = null, bestDiff = Infinity;
    for (const o of this.sockets()) {
      if (o === ws) continue;
      const oa = o.deserializeAttachment() || {};
      if (!oa.seek || oa.seek.tc !== a.seek.tc || oa.pid === a.pid) continue;
      const diff = Math.abs(oa.seek.rating - a.seek.rating);
      if (diff < bestDiff) { best = [o, oa]; bestDiff = diff; }
    }
    if (!best) return;
    const [o, oa] = best;
    const [wSock, wA, bSock, bA] = Math.random() < 0.5 ? [ws, a, o, oa] : [o, oa, ws, a];
    const code = newCode();
    await this.env.CHESS.get(this.env.CHESS.idFromName(code)).fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({
        w: wA.pid, b: bA.pid, tc: a.seek.tc,
        names: {
          [wA.pid]: { name: wA.seek.name, rating: wA.seek.rating },
          [bA.pid]: { name: bA.seek.name, rating: bA.seek.rating },
        },
      }),
    });
    for (const [s, sa] of [[wSock, wA], [bSock, bA]]) {
      s.serializeAttachment({ ...sa, seek: null });
      try { s.send(JSON.stringify({ t: "match", code, tc: a.seek.tc })); } catch {}
    }
  }

  async webSocketClose() { this.stats(); }
  async webSocketError() { this.stats(); }
}
