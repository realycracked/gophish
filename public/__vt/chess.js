// Échecs : parties classées (matchmaking, Elo, pendules), parties entre amis
// avec un code, ou à deux sur l'écran. Connexion directe au Worker, sans proxy.
import { Chess } from "/__vt/vendor/chess.js";

const $ = (id) => document.getElementById(id);
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TC_LABEL = { "1+0": "1 min", "3+0": "3 min", "3+2": "3 | 2", "5+0": "5 min", "10+0": "10 min", "15+10": "15 | 10" };

function read(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
function playerId() {
  let id = read("vt_chess_id");
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); store("vt_chess_id", id); }
  return id;
}
function newCode() {
  const a = new Uint32Array(5); crypto.getRandomValues(a);
  return Array.from(a, (n) => ALPHABET[n % ALPHABET.length]).join("");
}
const wsUrl = (path) => (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + path;

let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ---------- État ----------
let mode = null;          // "online" | "local"
let code = null;
let ws = null, wsRetry = 0, pingTimer = null, closedForGood = false;
let me = "w";             // couleur jouée (en ligne)
let moves = [];           // coups en notation SAN
let result = null;        // { winner, reason } ou null
let players = { w: false, b: false, bJoined: false };
let names = { w: null, b: null };
let rated = false, tcId = null, drawOffer = null, ratingChange = null;
let clock = null;         // { w, b, running, at } (at = heure locale de réception)
let abortAt = null;
let endShown = false;
let game = new Chess();
let selected = null;
let profile = null;
let tcSel = read("vt_chess_tc") || "10+0";

// ---------- Plateau ----------
// Deux couches : les cases (couleurs, surlignages) et les pièces, placées en
// absolu pour pouvoir glisser d'une case à l'autre (animation) ou suivre le doigt.
const board = $("board");
const FILES = "abcdefgh";
let shownLen = -1;        // nombre de coups affichés au dernier rendu
let skipAnim = false;     // coup joué au glisser : la pièce est déjà à sa place
let drag = null;          // { from, el, x0, y0, moved }

function orientation() { return mode === "online" && me === "b" ? "b" : "w"; }
function sqToXY(sq) {
  const f = FILES.indexOf(sq[0]), r = +sq[1];
  return orientation() === "b" ? [7 - f, r - 1] : [f, 8 - r];
}
function xyToSq(x, y) {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return orientation() === "b" ? FILES[7 - x] + (y + 1) : FILES[x] + (8 - y);
}
function place(el, sq) { const [x, y] = sqToXY(sq); el.style.transform = `translate(${x * 100}%, ${y * 100}%)`; }

// ---------- Sons (synthétisés, aucun fichier) ----------
let actx = null;
function sound(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const hit = (delay, freq, vol) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(freq, t + delay);
      o.frequency.exponentialRampToValueAtTime(freq * 0.45, t + delay + 0.09);
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(vol, t + delay + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.11);
      o.connect(g).connect(actx.destination);
      o.start(t + delay); o.stop(t + delay + 0.12);
    };
    if (kind === "capture") { hit(0, 260, 0.35); hit(0.045, 200, 0.3); }
    else if (kind === "check") { hit(0, 520, 0.25); hit(0.07, 700, 0.2); }
    else hit(0, 330, 0.3);
  } catch {}
}

function render() {
  game = new Chess();
  for (const san of moves) { try { game.move(san); } catch { break; } }
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const animate = shownLen >= 0 && moves.length === shownLen + 1 && last && !skipAnim;
  const newMove = shownLen >= 0 && moves.length === shownLen + 1 && last;
  shownLen = moves.length;
  skipAnim = false;

  const hints = new Map();
  if (selected) for (const m of game.moves({ square: selected, verbose: true })) hints.set(m.to, m);
  let checkSq = null;
  if (game.inCheck()) for (const row of game.board()) for (const c of row) if (c && c.type === "k" && c.color === game.turn()) checkSq = c.square;

  // Cases
  board.innerHTML = "";
  const sqLayer = document.createElement("div"); sqLayer.className = "squares";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const sq = xyToSq(x, y);
    const el = document.createElement("div");
    const light = (FILES.indexOf(sq[0]) + +sq[1]) % 2 === 1;
    el.className = "sq " + (light ? "l" : "d");
    el.dataset.sq = sq;
    if (last && (last.from === sq || last.to === sq)) el.classList.add("last");
    if (sq === selected) el.classList.add("sel");
    if (sq === checkSq) el.classList.add("check");
    if (hints.has(sq)) el.classList.add("hint", ...(game.get(sq) || hints.get(sq).flags.includes("e") ? ["cap"] : []));
    if (x === 0) el.insertAdjacentHTML("beforeend", `<span class="coord r">${sq[1]}</span>`);
    if (y === 7) el.insertAdjacentHTML("beforeend", `<span class="coord f">${sq[0]}</span>`);
    sqLayer.appendChild(el);
  }
  board.appendChild(sqLayer);

  // Pièces
  const pcLayer = document.createElement("div"); pcLayer.className = "pieces";
  const moving = [];
  for (const row of game.board()) for (const c of row) {
    if (!c) continue;
    const el = document.createElement("div");
    el.className = "pc " + c.color + c.type;
    el.dataset.sq = c.square;
    place(el, c.square);
    if (animate) {
      // Glissement depuis la case de départ (et la tour en cas de roque).
      let from = null;
      if (c.square === last.to) from = last.from;
      if (last.flags.includes("k") && c.type === "r" && c.square === "f" + last.to[1]) from = "h" + last.to[1];
      if (last.flags.includes("q") && c.type === "r" && c.square === "d" + last.to[1]) from = "a" + last.to[1];
      if (from) { place(el, from); el.classList.add("still"); moving.push([el, c.square]); }
    }
    pcLayer.appendChild(el);
  }
  board.appendChild(pcLayer);
  if (moving.length) {
    void pcLayer.offsetWidth; // applique la position de départ avant l'animation
    for (const [el, sq] of moving) { el.classList.remove("still"); el.classList.add("moving"); place(el, sq); }
  }
  if (newMove) sound(game.inCheck() ? "check" : last.captured ? "capture" : "move");
  renderSide();
}

function captured(color) {
  // Pièces de `color` prises par l'adversaire.
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const now = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of game.board()) for (const c of row) if (c && c.color === color && c.type !== "k") now[c.type]++;
  const list = []; let pts = 0;
  for (const t of ["q", "r", "b", "n", "p"]) {
    const n = Math.max(0, start[t] - now[t]);
    for (let i = 0; i < n; i++) list.push(color + t);
    pts += n * VALUE[t];
  }
  return { list, pts };
}

function renderSide() {
  const bottom = orientation();
  const top = bottom === "w" ? "b" : "w";
  const label = (c) => {
    if (mode === "local") return { name: c === "w" ? "Blancs" : "Noirs", elo: "" };
    const n = names[c];
    const base = n ? n.name : c === "w" ? "Blancs" : "Noirs";
    return { name: c === me ? base + " (toi)" : base, elo: n && n.rating ? "(" + n.rating + ")" : "" };
  };
  const fill = (el, c, capEl) => {
    const l = label(c);
    el.querySelector(".name").textContent = l.name;
    el.querySelector(".elo").textContent = l.elo;
    el.classList.toggle("on", mode === "local" || !!players[c]);
    el.classList.toggle("turn", !result && game.turn() === c && (mode === "local" || players.bJoined));
    const took = captured(c === "w" ? "b" : "w"), lost = captured(c);
    capEl.innerHTML = "";
    for (const k of took.list) { const i = document.createElement("span"); i.className = "pc mini " + k; capEl.appendChild(i); }
    if (took.pts > lost.pts) capEl.appendChild(document.createTextNode(" +" + (took.pts - lost.pts)));
  };
  fill($("p-top"), top, $("cap-top"));
  fill($("p-bot"), bottom, $("cap-bot"));
  $("clk-top").dataset.c = top; $("clk-bot").dataset.c = bottom;
  tickClocks();

  // Statut
  const st = $("status");
  st.classList.toggle("end", !!result);
  if (result) {
    st.textContent = resultTitle() + " · " + result.reason;
  } else if (mode === "online" && !players.bJoined) {
    st.textContent = "En attente de ton ami…";
  } else if (mode === "online" && me === "s") {
    st.textContent = "Tu regardes la partie";
  } else if (mode === "online" && drawOffer && drawOffer !== me) {
    st.textContent = "Ton adversaire propose la nulle";
  } else if (mode === "online" && abortAt != null && moves.length < 2) {
    st.textContent = (game.turn() === me ? "Joue ton premier coup" : "En attente du premier coup adverse") + " (sinon la partie est annulée)";
  } else if (mode === "online") {
    st.textContent = game.turn() === me ? (game.inCheck() ? "Échec ! À toi de jouer" : "À toi de jouer") : "Ton adversaire réfléchit…";
  } else {
    st.textContent = (game.turn() === "w" ? "Aux blancs" : "Aux noirs") + (game.inCheck() ? " · échec !" : "");
  }

  const playing = mode === "online" && me !== "s" && players.bJoined && !result;
  $("share").hidden = !(mode === "online" && !rated && !players.bJoined && me === "w");
  $("resign").hidden = !(playing || (mode === "local" && !result));
  $("resign").textContent = rated && moves.length < 2 ? "Annuler la partie" : "Abandonner";
  $("draw").hidden = !(playing && moves.length >= 2 && !drawOffer);
  $("draw-accept").hidden = $("draw-decline").hidden = !(playing && drawOffer && drawOffer !== me);
  $("undo").hidden = !(mode === "local" && moves.length && !result);

  // Liste des coups
  const ol = $("moves"); ol.innerHTML = "";
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement("li");
    li.innerHTML = "<b></b><span></span>";
    li.firstChild.textContent = moves[i];
    li.lastChild.textContent = moves[i + 1] || "";
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;

  if (result && !endShown) { endShown = true; setTimeout(showEnd, 600); }
  if (!result) { endShown = false; $("end").hidden = true; }
}

function resultTitle() {
  if (!result) return "";
  if (result.aborted) return "Partie annulée";
  if (result.winner === null) return "Partie nulle";
  if (mode === "local" || me === "s") return result.winner === "w" ? "Les blancs gagnent" : "Les noirs gagnent";
  return result.winner === me ? "Tu as gagné !" : "Tu as perdu";
}

// ---------- Pendules ----------
function fmt(ms) {
  ms = Math.max(0, ms);
  if (ms < 10_000) return (ms / 1000).toFixed(1);
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function remaining(c) {
  if (!clock) return null;
  let v = clock[c];
  if (clock.running === c && !result) v -= performance.now() - clock.at;
  return v;
}
let flagSent = 0;
function tickClocks() {
  for (const id of ["clk-top", "clk-bot"]) {
    const el = $(id), c = el.dataset.c;
    if (!clock || mode !== "online") { el.hidden = true; continue; }
    el.hidden = false;
    const v = remaining(c);
    el.textContent = fmt(v);
    el.classList.toggle("run", clock.running === c && !result);
    el.classList.toggle("low", v < 20_000);
    // Temps écoulé : on demande au serveur de constater (il le fait aussi seul).
    if (v <= 0 && clock.running === c && !result && performance.now() - flagSent > 2000) { flagSent = performance.now(); send({ t: "flag" }); }
  }
}
setInterval(() => { if (mode === "online" && clock && clock.running && !result) tickClocks(); }, 100);

// ---------- Fin de partie ----------
function showEnd() {
  if (!result) return;
  $("end-title").textContent = resultTitle();
  $("end-reason").textContent = result.aborted ? "Personne n'a joué son premier coup." : result.reason;
  const e = $("end-elo"); e.innerHTML = "";
  if (rated && ratingChange && ratingChange[me]) {
    const { before, after } = ratingChange[me], d = after - before;
    e.innerHTML = `<span>${before}</span> → <strong>${after}</strong> <em class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d}</em>`;
  }
  $("end-again").hidden = !(mode === "online" && rated);
  $("end-again").textContent = "Nouvelle partie " + (TC_LABEL[tcId] || "");
  $("end-rematch").hidden = !(mode === "local" || (mode === "online" && !rated && me !== "s"));
  $("end").hidden = false;
}
$("end-view").addEventListener("click", () => { $("end").hidden = true; });
$("end-lobby").addEventListener("click", () => { $("end").hidden = true; leave(); });
$("end-again").addEventListener("click", () => { const t = tcId; $("end").hidden = true; leave(); seek(t); });
$("end-rematch").addEventListener("click", () => {
  $("end").hidden = true;
  if (mode === "local") { moves = []; result = null; shownLen = -1; saveLocal(); render(); }
  else send({ t: "rematch" });
});

// ---------- Jouer ----------
function canMove() {
  if (result) return false;
  if (mode === "local") return true;
  return me !== "s" && players.bJoined && game.turn() === me;
}

// Toucher-toucher ou glisser-déposer (appui maintenu), comme sur chess.com.
function trySelectOrMove(sq) {
  const piece = game.get(sq);
  if (selected && selected !== sq) {
    const mv = game.moves({ square: selected, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      if (mv.some((m) => m.promotion)) { askPromotion(selected, sq); return true; }
      play(selected, sq);
      return true;
    }
  }
  return false;
}
function pointSq(e) {
  const r = board.getBoundingClientRect();
  return xyToSq(Math.floor((e.clientX - r.left) / r.width * 8), Math.floor((e.clientY - r.top) / r.height * 8));
}
board.addEventListener("pointerdown", (e) => {
  if (e.button > 0 || !canMove()) return;
  sound.warm = sound.warm || (actx = actx || new (window.AudioContext || window.webkitAudioContext)(), true);
  const sq = pointSq(e);
  if (!sq) return;
  if (trySelectOrMove(sq)) return;
  const piece = game.get(sq);
  if (!piece || piece.color !== game.turn()) { if (selected) { selected = null; render(); } return; }
  const wasSelected = selected === sq;
  selected = sq;
  render();
  const el = board.querySelector(`.pc[data-sq="${sq}"]`);
  if (!el) return;
  drag = { from: sq, el, x0: e.clientX, y0: e.clientY, moved: false, wasSelected };
  try { board.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
board.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true;
  const r = board.getBoundingClientRect(), size = r.width / 8;
  drag.el.classList.add("dragging");
  drag.el.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px) scale(1.12)`;
  const over = pointSq(e);
  board.querySelectorAll(".sq.over").forEach((s) => s.classList.remove("over"));
  if (over) { const s = board.querySelector(`.sq[data-sq="${over}"]`); if (s) s.classList.add("over"); }
});
function endDrag(e, cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  board.querySelectorAll(".sq.over").forEach((s) => s.classList.remove("over"));
  if (!d.moved) {
    // Simple toucher : un second toucher sur la même pièce la désélectionne.
    if (d.wasSelected) { selected = null; render(); }
    return;
  }
  const to = cancel ? null : pointSq(e);
  const legal = to && game.moves({ square: d.from, verbose: true }).filter((m) => m.to === to);
  if (legal && legal.length) {
    skipAnim = true;
    if (legal.some((m) => m.promotion)) { place(d.el, to); d.el.classList.remove("dragging"); askPromotion(d.from, to); }
    else play(d.from, to);
  } else {
    // Retour à la case de départ, en glissant.
    d.el.classList.remove("dragging"); d.el.classList.add("moving"); place(d.el, d.from);
  }
}
board.addEventListener("pointerup", (e) => endDrag(e, false));
board.addEventListener("pointercancel", (e) => endDrag(e, true));

function askPromotion(from, to) {
  const box = $("promo");
  box.innerHTML = "";
  for (const t of ["q", "r", "b", "n"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="pc ${game.turn()}${t}"></span>`;
    b.addEventListener("click", () => { box.hidden = true; play(from, to, t); });
    box.appendChild(b);
  }
  box.hidden = false;
}

function play(from, to, promotion) {
  selected = null;
  let mv;
  try { mv = game.move({ from, to, promotion: promotion || "q" }); } catch { mv = null; }
  if (!mv) return render();
  moves.push(mv.san);
  if (mode === "local") {
    result = outcome(game);
    saveLocal();
  } else {
    send({ t: "move", from, to, promotion: promotion || "q" });
  }
  render();
}

function outcome(c) {
  if (c.isCheckmate()) return { winner: c.turn() === "w" ? "b" : "w", reason: "échec et mat" };
  if (c.isStalemate()) return { winner: null, reason: "pat" };
  if (c.isInsufficientMaterial()) return { winner: null, reason: "matériel insuffisant" };
  if (c.isThreefoldRepetition()) return { winner: null, reason: "répétition" };
  if (c.isDraw()) return { winner: null, reason: "règle des 50 coups" };
  return null;
}

// ---------- Partie en ligne ----------
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function connect(join, tc) {
  closedForGood = false;
  const q = new URLSearchParams({ c: code, p: playerId() });
  if (join) q.set("join", "1");
  if (tc) q.set("tc", tc);
  if (profile) q.set("n", profile.name);
  const sock = new WebSocket(wsUrl("/__vt/chess/ws?" + q));
  ws = sock;
  sock.onopen = () => {
    wsRetry = 0;
    clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: "ping" }), 25000);
  };
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "error") {
      closedForGood = true;
      leave();
      $("lobby-err").textContent = m.msg;
      return;
    }
    if (m.t !== "state") return;
    const before = moves.length;
    me = m.you; moves = m.moves; result = m.result; players = m.players;
    names = m.names || { w: null, b: null }; rated = !!m.rated; tcId = m.tc || null;
    drawOffer = m.drawOffer || null; ratingChange = m.ratingChange || null;
    abortAt = m.abortAt;
    clock = m.clock ? { ...m.clock, at: performance.now() } : null;
    if (moves.length < before) shownLen = -1; // revanche : nouvelle partie
    if (moves.length > before && moves.length % 2 === (me === "w" ? 0 : 1) && navigator.vibrate) navigator.vibrate(20);
    if (moves.length !== before) selected = null;
    showGame();
    render();
  };
  sock.onclose = () => {
    if (sock !== ws) return; // ancienne connexion
    clearInterval(pingTimer);
    if (closedForGood || mode !== "online") return;
    $("status").textContent = "Connexion perdue, reconnexion…";
    setTimeout(() => { if (mode === "online" && !closedForGood) connect(false); }, Math.min(8000, 800 * 2 ** wsRetry++));
  };
}

function startOnline(c, join, tc) {
  mode = "online"; code = c; moves = []; result = null; shownLen = -1; endShown = false;
  players = { w: false, b: false, bJoined: false }; names = { w: null, b: null }; clock = null; drawOffer = null; ratingChange = null;
  history.replaceState(null, "", "/__vt/chess?c=" + code);
  $("code-chip").textContent = code; $("code-chip").hidden = false;
  $("big-code").textContent = code;
  connect(join, tc);
}

// ---------- À deux sur l'écran ----------
function saveLocal() { store("vt_chess_local", JSON.stringify({ moves, result })); }
function startLocal() {
  mode = "local"; code = null; me = "w"; clock = null; rated = false; shownLen = -1; endShown = false;
  moves = []; result = null;
  try { const s = JSON.parse(read("vt_chess_local")); if (s && Array.isArray(s.moves)) { moves = s.moves; result = s.result; endShown = !!result; } } catch {}
  history.replaceState(null, "", "/__vt/chess?local=1");
  $("code-chip").hidden = true;
  showGame(); render();
}

// ---------- Écrans ----------
function showGame() {
  $("lobby").hidden = true; $("game").hidden = false; $("seeking").hidden = true; $("online").hidden = true;
}
function leave() {
  closedForGood = true;
  if (ws) try { ws.close(); } catch {}
  ws = null; mode = null; code = null; moves = []; result = null; selected = null; clock = null;
  history.replaceState(null, "", "/__vt/chess");
  $("code-chip").hidden = true; $("end").hidden = true;
  $("game").hidden = true; $("lobby").hidden = false; $("online").hidden = false;
  lobbySend({ t: "top" });
}

// ---------- Lobby : profil, matchmaking, classement ----------
let lobby = null, lobbyRetry = 0, seekingTc = null;
function lobbySend(m) { if (lobby && lobby.readyState === 1) lobby.send(JSON.stringify(m)); }
function connectLobby() {
  const sock = new WebSocket(wsUrl("/__vt/chess/lobby?p=" + encodeURIComponent(playerId())));
  lobby = sock;
  sock.onopen = () => { lobbyRetry = 0; sock.send(JSON.stringify({ t: "top" })); if (seekingTc) sock.send(JSON.stringify({ t: "seek", tc: seekingTc })); };
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "me") { profile = m.profile; renderProfile(); }
    else if (m.t === "stats") {
      $("online").textContent = m.online + " en ligne"; $("online").hidden = mode !== null;
      if (seekingTc) $("seek-sub").textContent = TC_LABEL[seekingTc] + " · " + Math.max(0, (m.seeking[seekingTc] || 1) - 1) + " autre(s) joueur(s) en recherche · " + m.online + " en ligne";
    }
    else if (m.t === "top") renderTop(m.list);
    else if (m.t === "error") toast(m.msg);
    else if (m.t === "match") {
      seekingTc = null; $("seeking").hidden = true;
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      sound("check");
      startOnline(m.code, true);
    }
  };
  sock.onclose = () => { if (lobby === sock) setTimeout(connectLobby, Math.min(10000, 1000 * 2 ** lobbyRetry++)); };
}

function renderProfile() {
  if (!profile) return;
  $("me-name").textContent = profile.name + " ✎";
  $("me-avatar").textContent = profile.name.charAt(0).toUpperCase();
  $("me-elo").textContent = profile.rating;
  $("me-stats").textContent = profile.games
    ? `${profile.games} partie${profile.games > 1 ? "s" : ""} · ${profile.w} V · ${profile.d} N · ${profile.l} D`
    : "Pas encore de partie classée";
}
function renderTop(list) {
  const ol = $("top20"); ol.innerHTML = "";
  if (!list.length) { ol.innerHTML = '<li class="muted">Personne n\'a encore joué de partie classée.</li>'; return; }
  list.forEach((p, i) => {
    const li = document.createElement("li");
    if (p.me) li.className = "me-row";
    li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="gm"></span><span class="rt"></span>';
    li.children[0].textContent = i + 1;
    li.children[1].textContent = p.name;
    li.children[2].textContent = p.games + " p.";
    li.children[3].textContent = p.rating;
    ol.appendChild(li);
  });
}
$("me-name").addEventListener("click", () => {
  const n = prompt("Ton pseudo (2 à 16 caractères) :", profile ? profile.name : "");
  if (n != null) lobbySend({ t: "name", name: n });
});

// Cadence
function markTc() {
  document.querySelectorAll("#tcs button").forEach((b) => b.classList.toggle("on", b.dataset.tc === tcSel));
  $("play").textContent = "Jouer · " + TC_LABEL[tcSel];
}
document.querySelectorAll("#tcs button").forEach((b) => b.addEventListener("click", () => { tcSel = b.dataset.tc; store("vt_chess_tc", tcSel); markTc(); }));
markTc();

function seek(tc) {
  if (!tc) return;
  seekingTc = tc;
  $("seek-sub").textContent = TC_LABEL[tc];
  $("seeking").hidden = false;
  lobbySend({ t: "seek", tc });
}
$("play").addEventListener("click", () => {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  seek(tcSel);
});
$("seek-cancel").addEventListener("click", () => { seekingTc = null; $("seeking").hidden = true; lobbySend({ t: "cancel" }); });

// Entre amis
$("create").addEventListener("click", () => {
  $("lobby-err").textContent = "";
  startOnline(newCode(), false, $("nolimit").checked ? null : tcSel);
});
$("join").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = $("join-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(c)) { $("lobby-err").textContent = "Le code fait 5 caractères (ex. K7QXM)."; return; }
  $("lobby-err").textContent = "";
  startOnline(c, true);
});
$("join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
$("local").addEventListener("click", startLocal);

// Boutons de partie
$("leave").addEventListener("click", () => {
  if (mode === "online" && !result && me !== "s" && players.bJoined && moves.length >= 2 && !confirm("Quitter ? Ta pendule continue de tourner.")) return;
  leave();
});
$("resign").addEventListener("click", () => {
  const abort = rated && moves.length < 2;
  if (!confirm(abort ? "Annuler la partie ?" : "Abandonner la partie ?")) return;
  if (mode === "local") { result = { winner: game.turn() === "w" ? "b" : "w", reason: "abandon" }; saveLocal(); render(); }
  else send({ t: "resign" });
});
$("draw").addEventListener("click", () => { send({ t: "draw" }); toast("Nulle proposée"); });
$("draw-accept").addEventListener("click", () => send({ t: "draw" }));
$("draw-decline").addEventListener("click", () => send({ t: "decline" }));
$("undo").addEventListener("click", () => { moves.pop(); result = null; shownLen = -1; saveLocal(); render(); });

async function shareLink() {
  const link = location.origin + "/__vt/chess?c=" + code;
  if (navigator.share) { try { await navigator.share({ title: "Partie d'échecs", text: "Rejoins ma partie, code " + code, url: link }); return; } catch {} }
  try { await navigator.clipboard.writeText(link); toast("Lien copié"); } catch { toast("Code : " + code); }
}
$("share-btn").addEventListener("click", shareLink);
$("code-chip").addEventListener("click", shareLink);

// Démarrage. Lien direct /__vt/chess?c=CODE : rejoint la partie.
connectLobby();
const params = new URLSearchParams(location.search);
const c0 = (params.get("c") || "").toUpperCase();
if (/^[A-HJ-NP-Z2-9]{5}$/.test(c0)) startOnline(c0, true);
else if (params.get("local")) startLocal();
