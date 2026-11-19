// Échecs en ligne : une partie = un Durable Object (nommé par son code).
// Les joueurs s'y connectent en WebSocket, directement (pas de proxy).
// Le serveur vérifie chaque coup avec chess.js : impossible de tricher.
import { Chess } from "chess.js";

export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

// Route /__vt/chess/ws?c=CODE&p=<id joueur>[&join=1]
export function chessSocket(request, url, env) {
  if (request.headers.get("upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
  const code = (url.searchParams.get("c") || "").toUpperCase();
  if (!CODE_RE.test(code)) return new Response("Code invalide", { status: 400 });
  if (!env.CHESS) return new Response("Échecs indisponibles", { status: 503 });
  return env.CHESS.get(env.CHESS.idFromName(code)).fetch(request);
}

export class ChessRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async load() {
    return (await this.ctx.storage.get("game")) || null;
  }
  async save(g) {
    await this.ctx.storage.put("game", g);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pid = (url.searchParams.get("p") || "").slice(0, 40) || crypto.randomUUID();
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
      g = { w: pid, b: null, moves: [], result: null, created: Date.now() };
    } else if (g.w !== pid && g.b !== pid) {
      if (!g.w) g.w = pid;
      else if (!g.b) g.b = pid;
    }
    // Plus de 30 jours sans jouer : la partie est oubliée.
    await this.ctx.storage.setAlarm(Date.now() + 30 * 86400e3);
    await this.save(g);
    this.broadcast(g);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  online() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === 1) for (const t of this.ctx.getTags(ws)) ids.add(t);
    }
    return ids;
  }

  view(g, pid, on) {
    return JSON.stringify({
      t: "state",
      you: g.w === pid ? "w" : g.b === pid ? "b" : "s",
      moves: g.moves,
      result: g.result,
      players: { w: !!g.w && on.has(g.w), b: !!g.b && on.has(g.b), bJoined: !!g.b },
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

    if (m.t === "move") {
      if (!color || g.result) return;
      const chess = replay(g.moves);
      if (chess.turn() !== color) return this.reject(ws, g, pid);
      let mv;
      try { mv = chess.move({ from: m.from, to: m.to, promotion: m.promotion || "q" }); } catch { mv = null; }
      if (!mv) return this.reject(ws, g, pid);
      g.moves.push(mv.san);
      g.result = outcome(chess);
    } else if (m.t === "resign") {
      if (!color || g.result) return;
      g.result = { winner: color === "w" ? "b" : "w", reason: "abandon" };
    } else if (m.t === "rematch") {
      if (!color || !g.result) return;
      g = { ...g, w: g.b, b: g.w, moves: [], result: null };
    } else if (m.t === "ping") {
      return;
    } else {
      return;
    }
    await this.save(g);
    this.broadcast(g);
  }

  reject(ws, g, pid) {
    ws.send(this.view(g, pid, this.online()));
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
