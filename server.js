// Elo Ladder multiplayer server — no dependencies, Node 18+.
// Serves the site, runs the lobby, validates every move with chess.js,
// keeps the clocks, and stores ratings in data/players.json.
//
// Clients listen on a Server-Sent Events stream (/api/events) and send
// actions as JSON POSTs, authenticated with the token from /api/login.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { Chess } = require("./vendor/chess.min.js");
const { recordMatch } = require("./elo.js");
const { checkName, cleanText } = require("./names.js");
const anticheat = require("./anticheat.js");

const PORT = +process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const ABANDON_MS = 60_000; // disconnected this long mid-game = loss
const TIME_CONTROLS = { "3+2": [3, 2], "5+0": [5, 0], "10+0": [10, 0], "15+10": [15, 10], "none": [0, 0] };

// ---------- players ----------

let players = {};
try { players = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")); } catch {}

// Run fn, logging instead of crashing if it throws (timers and saves use this)
function guard(label, fn) {
  try { return fn(); } catch (err) { console.error(`[${label}]`, err); }
}

let saveTimer = null;
function savePlayers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => guard("saving players", () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PLAYERS_FILE + ".tmp", JSON.stringify(players, null, 1));
    fs.renameSync(PLAYERS_FILE + ".tmp", PLAYERS_FILE);
  }), 200);
}

const tokens = new Map(Object.values(players).map((p) => [p.token, p]));
const byToken = (token) => token && tokens.get(token);
const publicPlayer = (p) => ({ name: p.name, elo: Math.round(p.elo), games: p.games });
const NAME_COOLDOWN_MS = 180 * 24 * 3600 * 1000;
// What a player sees about themselves
const meView = (p) => ({ ...publicPlayer(p), admin: !!p.admin, blocked: p.blocked || [], nameChangedAt: p.nameChangedAt || null, nextNameChange: p.nameChangedAt ? p.nameChangedAt + NAME_COOLDOWN_MS : null });

// ---------- admin + sanctions ----------

// The account named ADMIN_NAME is the admin. Claiming that name (or signing
// into it on a new device) needs the secret key in data/admin-key.txt.
const ADMIN_NAME = process.env.ADMIN_NAME || ""; // empty: no reserved admin name
const ADMIN_KEY_FILE = path.join(DATA_DIR, "admin-key.txt");
let adminKey;
try { adminKey = fs.readFileSync(ADMIN_KEY_FILE, "utf8").trim(); } catch {}
// Only keep a key when there is a reserved admin name to protect
if (!adminKey && ADMIN_NAME) {
  adminKey = crypto.randomBytes(9).toString("base64url");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_KEY_FILE, adminKey + "\n");
}
// More admins: data/admins.json maps each extra admin name to its own secret
// key, needed to claim that name or sign into it on a new device.
const ADMINS_FILE = path.join(DATA_DIR, "admins.json");
let extraAdmins = {};
try { extraAdmins = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8")); } catch {}
const lc = (s) => String(s || "").trim().toLowerCase();
const isAdminName = (name) => (!!ADMIN_NAME && lc(name) === lc(ADMIN_NAME)) || Object.keys(extraAdmins).some((n) => lc(n) === lc(name));
const adminKeyFor = (name) => lc(name) === lc(ADMIN_NAME) ? adminKey : Object.entries(extraAdmins).find(([n]) => lc(n) === lc(name))?.[1];
for (const acct of Object.values(players)) {
  if (isAdminName(acct.name) && !acct.admin) { acct.admin = true; savePlayers(); }
}

// Networks blocked along with a ban
const bannedIps = new Set(Object.values(players).map((p) => p.ban && p.ban.ip).filter(Boolean));

// null when the player is allowed in, otherwise why not
function sanctionOf(p) {
  if (p.ban) return { kind: "ban", reason: p.ban.reason, message: `This account is banned.${p.ban.reason ? ` Reason: ${p.ban.reason}` : ""}` };
  if (p.restriction && p.restriction.until > Date.now()) {
    const until = new Date(p.restriction.until).toUTCString();
    return { kind: "restriction", until: p.restriction.until, reason: p.restriction.reason,
      message: `This account is restricted until ${until}.${p.restriction.reason ? ` Reason: ${p.restriction.reason}` : ""}` };
  }
  return null;
}

// ---------- AI moderator: reports for the admin ----------

// Reports: { id, at, kind: "cheating"|"name"|"same-network", severity: "low"|"medium"|"high",
//   player, summary, gameId?, status: "open"|"dismissed"|"resolved", updatedAt }
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
let reports = [];
try { reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8")); } catch {}
let reportsTimer = null;
function saveReports() {
  clearTimeout(reportsTimer);
  reportsTimer = setTimeout(() => guard("saving reports", () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORTS_FILE + ".tmp", JSON.stringify(reports.slice(0, 2000), null, 1));
    fs.renameSync(REPORTS_FILE + ".tmp", REPORTS_FILE);
  }), 200);
}
const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };
const openReports = () => reports.filter((r) => r.status === "open");
function notifyAdmins() {
  const open = openReports().length;
  for (const p of Object.values(players)) if (p.admin) send(p.name, { type: "reports", open });
}
// Adds a report, or updates the player's open report of the same kind (dedupeKey) instead of piling up
function addReport({ kind, severity, player, summary, gameId = null, dedupeKey = null }) {
  const key = dedupeKey || `${kind}:${player}`;
  const existing = reports.find((r) => r.status === "open" && r.key === key);
  if (existing) {
    if (SEVERITY_RANK[severity] >= SEVERITY_RANK[existing.severity]) { existing.severity = severity; existing.summary = summary; }
    existing.count = (existing.count || 1) + 1;
    existing.updatedAt = Date.now();
    if (gameId) existing.gameId = gameId;
  } else {
    reports.unshift({ id: newId(), key, at: Date.now(), updatedAt: Date.now(), kind, severity, player, summary, gameId, status: "open", count: 1 });
  }
  console.log(`[ai] ${severity} ${kind} report: ${player} — ${summary}`);
  saveReports();
  notifyAdmins();
}

// Second opinion on new names from the local AI (Ollama). If it's not
// running, names are still checked by the rules in names.js.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";
const aiNameCache = new Map();
async function aiNameVerdict(name) {
  const key = name.toLowerCase();
  if (aiNameCache.has(key)) return aiNameCache.get(key);
  const prompt = `You moderate usernames for a chess game played by all ages, including kids.
Username: "${name}"
Is this username clearly inappropriate (sexual, hateful, slurs, harassment, drugs, extremist, or impersonating staff)? Normal gamer names, nicknames, and chess or fantasy words like "killer", "slayer", "dark" are fine.
Reply JSON only: {"allowed": true or false, "reason": "short reason"}`;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "user", content: prompt }] }),
    });
    const v = JSON.parse((await res.json()).message.content);
    const verdict = { allowed: v.allowed !== false, reason: String(v.reason || "").slice(0, 120), checked: true };
    aiNameCache.set(key, verdict);
    return verdict;
  } catch {
    return { allowed: true, checked: false };
  }
}
// Full name check for players: rules first, then the AI
async function screenName(name, who) {
  const rule = checkName(name);
  if (!rule.ok) fail(400, rule.reason);
  const ai = await aiNameVerdict(name);
  if (!ai.allowed) {
    addReport({ kind: "name", severity: "low", player: who || name, summary: `Tried the name "${name}" — blocked by the AI moderator (${ai.reason || "inappropriate"}).`, dedupeKey: `name-try:${name.toLowerCase()}` });
    fail(400, "That name isn't allowed. Please pick a different one.");
  }
}

function logSanction(p, action, by, extra = {}) {
  (p.sanctionLog || (p.sanctionLog = [])).unshift({ at: Date.now(), action, by, ...extra });
  p.sanctionLog = p.sanctionLog.slice(0, 100);
  console.log(`[admin] ${by} → ${action} ${p.name}${extra.reason ? ` (${extra.reason})` : ""}`);
}

// ---------- connections ----------

const streams = new Map(); // name -> Set of SSE responses
const lastSeen = new Map(); // name -> time the last stream closed

function send(name, msg) {
  for (const res of streams.get(name) || []) if (!res.writableEnded) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
const online = (name) => (streams.get(name)?.size || 0) > 0;

// ---------- games ----------

const games = new Map();
const newId = () => crypto.randomBytes(4).toString("hex");

function clockNow(g) {
  const clocks = { ...g.clocks };
  if (g.status === "playing" && g.turnStart && g.base) {
    const turn = g.chess.turn();
    clocks[turn] = Math.max(0, clocks[turn] - (Date.now() - g.turnStart));
  }
  return clocks;
}

function gameView(g) {
  return {
    id: g.id, status: g.status, tc: g.tc,
    white: g.white && { ...publicPlayer(players[g.white]), online: online(g.white) },
    black: g.black && { ...publicPlayer(players[g.black]), online: online(g.black) },
    creator: g.creator, creatorColor: g.creatorColor,
    pgn: g.chess.pgn(), fen: g.chess.fen(), turn: g.chess.turn(),
    clocks: g.base ? clockNow(g) : null, running: !!(g.turnStart && g.status === "playing"),
    result: g.result, reason: g.reason, changes: g.changes,
    drawOffer: g.drawOffer, rematch: [...g.rematch], next: g.next, chat: g.chat.slice(-50),
  };
}

function pushGame(g) {
  const view = gameView(g);
  for (const name of new Set([g.white, g.black, g.creator])) if (name) send(name, { type: "game", game: view });
}

function lobbyView() {
  const open = [...games.values()].filter((g) => g.status === "open").map((g) => ({
    id: g.id, tc: g.tc, color: g.creatorColor, creator: publicPlayer(players[g.creator]),
  }));
  const live = [...games.values()].filter((g) => g.status === "playing").length;
  const leaderboard = Object.values(players).filter((p) => p.games > 0)
    .sort((a, b) => b.elo - a.elo).slice(0, 25)
    .map((p) => ({ ...publicPlayer(p), online: online(p.name) }));
  const onlineCount = [...streams.values()].filter((s) => s.size).length;
  const searching = {};
  for (const q of queue.values()) searching[q.tc] = (searching[q.tc] || 0) + 1;
  return { type: "lobby", open, live, leaderboard, online: onlineCount, searching };
}

function pushLobby() {
  const msg = lobbyView();
  for (const name of streams.keys()) send(name, msg);
}

// ---------- matchmaking ----------

// name -> { tc, since }. Players are paired with someone on the same time
// control whose rating is close; the allowed gap widens the longer they wait,
// so nobody waits forever when few people are online.
const queue = new Map();

const ratingWindow = (waitedMs) => (waitedMs > 20_000 ? Infinity : 100 + waitedMs / 50); // 100 → 500 over 20s

function sendQueue(name) {
  const q = queue.get(name);
  send(name, { type: "queue", queue: q ? { tc: q.tc, since: q.since } : null });
}

function leaveQueue(name) {
  if (queue.delete(name)) { sendQueue(name); pushLobby(); }
}

function matchmake() {
  const now = Date.now();
  const waiting = [...queue.entries()].sort((a, b) => a[1].since - b[1].since);
  const paired = new Set();
  for (const [a, qa] of waiting) {
    if (paired.has(a)) continue;
    let best = null;
    for (const [b, qb] of waiting) {
      if (b === a || paired.has(b) || qb.tc !== qa.tc || isBlocked(a, b) || isBlocked(b, a)) continue;
      const gap = Math.abs(players[a].elo - players[b].elo);
      const allowed = Math.max(ratingWindow(now - qa.since), ratingWindow(now - qb.since));
      if (gap <= allowed && (!best || gap < best.gap)) best = { b, gap };
    }
    if (!best) continue;
    paired.add(a); paired.add(best.b);
    queue.delete(a); queue.delete(best.b);
    const g = createGame(a, qa.tc, "random");
    startGame(g, best.b);
    sendQueue(a); sendQueue(best.b);
    pushGame(g);
  }
  if (paired.size) pushLobby();
}

// ---------- friends ----------

// Stored on each player: friends (names) and requests (names who asked them).
// Challenges are live-only: id -> { id, from, to, tc, at }, expiring after a minute.
const challenges = new Map();
const CHALLENGE_MS = 60_000;

const friendsOf = (name) => players[name].friends || (players[name].friends = []);
const requestsOf = (name) => players[name].requests || (players[name].requests = []);
const findPlayer = (name) => {
  const key = Object.keys(players).find((k) => k.toLowerCase() === String(name || "").trim().toLowerCase());
  return key && players[key];
};

function friendsView(name) {
  const status = (n) => (!online(n) ? "offline" : activeGameOf(n)?.status === "playing" ? "playing" : "online");
  const order = { online: 0, playing: 1, offline: 2 };
  const friends = friendsOf(name).filter((n) => players[n])
    .map((n) => ({ ...publicPlayer(players[n]), status: status(n) }))
    .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const incoming = requestsOf(name).filter((n) => players[n]).map((n) => publicPlayer(players[n]));
  const outgoing = Object.values(players).filter((p) => (p.requests || []).includes(name)).map((p) => p.name);
  const chals = [...challenges.values()].filter((c) => c.to === name || c.from === name)
    .map((c) => ({ id: c.id, from: c.from, to: c.to, tc: c.tc, fromElo: Math.round(players[c.from].elo) }));
  return { type: "friends", friends, incoming, outgoing, challenges: chals };
}

// Tell a player and everyone who lists them as a friend
function pushFriends(...names) {
  const targets = new Set();
  for (const n of names) {
    if (!players[n]) continue;
    targets.add(n);
    for (const f of friendsOf(n)) targets.add(f);
  }
  for (const n of targets) if (online(n)) send(n, friendsView(n));
}

function dropChallenges(name) {
  for (const c of challenges.values()) {
    if (c.from === name || c.to === name) { challenges.delete(c.id); pushFriends(c.from, c.to); }
  }
}

function activeGameOf(name) {
  return [...games.values()].find((g) => g.status !== "over" && (g.white === name || g.black === name || g.creator === name));
}

function createGame(creator, tc, color) {
  const [mins, inc] = TIME_CONTROLS[tc];
  const g = {
    id: newId(), status: "open", tc, base: mins * 60_000, inc: inc * 1000,
    creator, creatorColor: color, white: null, black: null,
    chess: new Chess(), clocks: { w: mins * 60_000, b: mins * 60_000 }, turnStart: null,
    result: null, reason: null, changes: null, drawOffer: null, rematch: new Set(), next: null, chat: [],
    moveTimes: { w: [], b: [] },
  };
  games.set(g.id, g);
  return g;
}

function startGame(g, joiner) {
  const color = g.creatorColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : g.creatorColor;
  g.white = color === "w" ? g.creator : joiner;
  g.black = color === "w" ? joiner : g.creator;
  g.status = "playing";
  // Two accounts on one network playing each other can be one person farming rating
  const ipW = players[g.white].lastIp, ipB = players[g.black].lastIp;
  g.sameNet = !!(ipW && ipW === ipB);
  dropChallenges(g.white); dropChallenges(g.black);
  pushFriends(g.white, g.black); // friends see them as "playing"
}

// result is from white's point of view (1, 0.5, 0); null = aborted, unrated
function endGame(g, result, reason) {
  if (g.status !== "playing") return;
  if (g.base && g.turnStart) {
    const t = g.chess.turn();
    g.clocks[t] = Math.max(0, g.clocks[t] - (Date.now() - g.turnStart));
  }
  g.status = "over";
  g.result = result;
  g.reason = reason;
  g.drawOffer = null;
  if (result !== null) {
    const w = players[g.white], b = players[g.black];
    const [cw, cb] = recordMatch(w, b, result);
    for (const [p, score] of [[w, result], [b, 1 - result]]) {
      const key = score === 1 ? "wins" : score === 0 ? "losses" : "draws";
      p[key] = (p[key] || 0) + 1;
    }
    g.changes = { w: cw, b: cb };
  }
  // Per-player game history (also shown to the admin)
  for (const [name, color] of [[g.white, "w"], [g.black, "b"]]) {
    const p = players[name];
    if (!p) continue;
    const score = result === null ? null : color === "w" ? result : 1 - result;
    (p.history || (p.history = [])).unshift({
      at: Date.now(), opp: color === "w" ? g.black : g.white, color, tc: g.tc, result: score, reason,
      change: g.changes ? g.changes[color] : 0, elo: Math.round(p.elo), moves: g.chess.history().length, id: g.id,
    });
    p.history = p.history.slice(0, 100);
  }
  savePlayers();
  if (result !== null) reviewGame(g);
  pushGame(g);
  pushLobby();
  pushFriends(g.white, g.black);
  // Finished games linger so rematch offers work, then get cleaned up
  setTimeout(() => { if (g.status === "over") games.delete(g.id); }, 30 * 60_000);
}

function checkPositionEnd(g) {
  const c = g.chess;
  if (!c.game_over()) return;
  if (c.in_checkmate()) return endGame(g, c.turn() === "w" ? 0 : 1, "checkmate");
  const reason = c.in_stalemate() ? "stalemate" : c.in_threefold_repetition() ? "repetition"
    : c.insufficient_material() ? "insufficient material" : "50-move rule";
  endGame(g, 0.5, reason);
}

// AI review of a finished rated game: same-network check now, engine
// analysis in the background (it takes ~10 seconds per game).
function reviewGame(g) {
  const accounts = { w: players[g.white], b: players[g.black] };
  if (g.sameNet) {
    const pair = [g.white, g.black].sort();
    addReport({ kind: "same-network", severity: "low", player: g.white,
      summary: `${g.white} and ${g.black} played a rated game from the same network. Fine for family or friends at one house — but could be one person boosting a second account.`,
      gameId: g.id, dedupeKey: `same-network:${pair.join("|")}` });
  }
  const moves = g.chess.history({ verbose: true });
  if (moves.length < 20) return; // too short to say anything
  anticheat.analyzeGame(moves).then((stats) => {
    for (const color of ["w", "b"]) {
      const p = accounts[color];
      if (!p || !stats[color] || !stats[color].moves) continue;
      const s = { ...stats[color], at: Date.now(), gameId: g.id };
      const entry = (p.history || []).find((h) => h.id === g.id);
      if (entry) entry.ai = { accuracy: s.accuracy, match: s.match, acpl: s.acpl, moves: s.moves };
      // Judge against the rating they had going into the game
      const elo = p.elo - (g.changes ? g.changes[color] : 0);
      const flag = anticheat.judge(s, elo, g.moveTimes[color]);
      s.flag = flag ? flag.severity : null;
      p.aiRecent = [s, ...(p.aiRecent || [])].slice(0, 10);
      if (flag) addReport({ kind: "cheating", severity: flag.severity, player: p.name, summary: flag.summary, gameId: g.id });
      // Several flagged games, or the last games added up, look like an engine
      const flagged = p.aiRecent.filter((r) => r.flag).length;
      const combined = anticheat.judge(anticheat.combine(p.aiRecent), elo, null, { label: `last ${p.aiRecent.length} games` });
      if (flagged >= 2 || (combined && p.aiRecent.length >= 2)) {
        addReport({ kind: "cheating", severity: flagged >= 2 ? "high" : combined.severity, player: p.name, gameId: g.id,
          summary: `${flagged >= 2 ? `Flagged in ${flagged} of their last ${p.aiRecent.length} games. ` : ""}${(combined || flag).summary}` });
      }
    }
    savePlayers();
  }).catch((err) => console.error("[ai] analysis failed:", err.message));
}

// Throw a player out right now: forfeit their game, clear their seeks, queue
// spot and challenges, and close their live connections with a message.
function removePlayer(name, notice) {
  const g = activeGameOf(name);
  if (g && g.status === "open") games.delete(g.id);
  if (g && g.status === "playing") {
    const color = g.white === name ? "w" : "b";
    if (g.chess.history().length < 2) endGame(g, null, "aborted — player removed");
    else endGame(g, color === "w" ? 0 : 1, "opponent removed by an admin");
  }
  queue.delete(name);
  dropChallenges(name);
  const conns = streams.get(name) || new Set();
  for (const res of [...conns]) {
    res.write(`data: ${JSON.stringify({ type: "removed", ...notice })}\n\n`);
    res.end();
    conns.delete(res);
    setTimeout(() => res.socket && res.socket.destroy(), 200);
  }
  lastSeen.set(name, Date.now());
  pushLobby();
  pushFriends(name);
}

// Rename an account everywhere it's referenced (friends, games, connections)
function renamePlayer(p, name) {
  const old = p.name;
  const swap = (n) => (n === old ? name : n);
  delete players[old];
  p.name = name;
  players[name] = p;
  for (const other of Object.values(players)) {
    if (other.friends) other.friends = other.friends.map(swap);
    if (other.requests) other.requests = other.requests.map(swap);
    if (other.blocked) other.blocked = other.blocked.map(swap);
  }
  for (const g of games.values()) {
    g.white = swap(g.white); g.black = swap(g.black); g.creator = swap(g.creator);
    if (g.rematch.delete(old)) g.rematch.add(name);
  }
  for (const c of challenges.values()) { c.from = swap(c.from); c.to = swap(c.to); }
  for (const map of [streams, lastSeen, lastChat, queue]) {
    if (map.has(old)) { map.set(name, map.get(old)); map.delete(old); }
  }
  savePlayers();
  send(name, { type: "me", me: meView(p) });
  pushFriends(name);
  pushLobby();
  const g = activeGameOf(name);
  if (g) pushGame(g);
}

// Widening rating windows can create new pairings as time passes;
// unanswered friend challenges expire
setInterval(() => guard("matchmaking", () => {
  matchmake();
  for (const c of challenges.values()) {
    if (Date.now() - c.at > CHALLENGE_MS) { challenges.delete(c.id); pushFriends(c.from, c.to); }
  }
}), 1000);

// Flag falls and abandoned games (each game checked separately, so one bad game can't stop the rest)
function checkGameTimers(g, now) {
  if (g.status === "open" && !online(g.creator) && now - (lastSeen.get(g.creator) || now) > ABANDON_MS) {
    games.delete(g.id);
    pushLobby();
    return;
  }
  if (g.status !== "playing") return;
  if (g.base && g.turnStart) {
    const t = g.chess.turn();
    if (g.clocks[t] - (now - g.turnStart) <= 0) return endGame(g, t === "w" ? 0 : 1, "timeout");
  }
  for (const [name, color] of [[g.white, "w"], [g.black, "b"]]) {
    if (!online(name) && now - (lastSeen.get(name) || now) > ABANDON_MS) {
      if (g.chess.history().length < 2) endGame(g, null, "aborted — player left");
      else endGame(g, color === "w" ? 0 : 1, "abandoned");
      return;
    }
  }
}
setInterval(() => {
  const now = Date.now();
  for (const g of [...games.values()]) guard(`game ${g.id}`, () => checkGameTimers(g, now));
}, 250);

// ---------- actions ----------

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const keyMatches = (given, name) => {
  const key = adminKeyFor(name);
  if (!key) return false;
  const a = Buffer.from(String(given || "")), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const refuseIfSanctioned = (p) => {
  const s = sanctionOf(p);
  if (s) fail(403, s.message, { sanction: s });
};
const requireAdmin = (me) => { if (!players[me] || !players[me].admin) fail(403, "Admins only"); };
function adminTarget(body, me, { notAdmin = true } = {}) {
  requireAdmin(me);
  const p = findPlayer(body.name);
  if (!p) fail(404, "No player with that name");
  if (notAdmin && p.admin) fail(400, "You can't do that to an admin");
  return p;
}
// Has `blocker` blocked `who`?
const isBlocked = (blocker, who) => !!(players[blocker] && (players[blocker].blocked || []).includes(who));
const playerStatus = (name) => (!online(name) ? "offline" : activeGameOf(name)?.status === "playing" ? "playing" : "online");
const NAME_RULE = /^[A-Za-z0-9 _-]{2,20}$/;

function myGame(me, id) {
  const g = games.get(id);
  if (!g) fail(404, "Game not found");
  const color = g.white === me ? "w" : g.black === me ? "b" : null;
  return { g, color };
}

// Light abuse limits for a public server
const signups = new Map(); // ip -> timestamps of new players in the last hour
function allowSignup(ip) {
  const now = Date.now();
  const recent = (signups.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  signups.set(ip, recent);
  return true;
}
const lastChat = new Map(); // name -> time of last chat message

const actions = {
  async login(body, me, ip) {
    // A device that already has an account stays that account (even if it was renamed)
    const owner = body.token && tokens.get(body.token);
    if (owner) {
      refuseIfSanctioned(owner);
      owner.lastIp = ip;
      return { ...publicPlayer(owner), token: owner.token };
    }
    const name = String(body.name || "").trim();
    if (!NAME_RULE.test(name)) fail(400, "Names are 2–20 letters, numbers, spaces, _ or -");
    const existing = findPlayer(name);
    if (existing) {
      // The admin can sign in on a new device with the admin key
      if (existing.admin && keyMatches(body.adminKey, existing.name)) {
        existing.lastIp = ip;
        return { ...publicPlayer(existing), token: existing.token };
      }
      if (existing.admin) fail(401, `Enter the admin key to sign in as ${existing.name}`, { needKey: true });
      fail(409, "That name is taken");
    }
    if (bannedIps.has(ip)) fail(403, "New accounts can't be made from this network.");
    if (isAdminName(name) && !keyMatches(body.adminKey, name)) fail(401, "That name is reserved. Enter the admin key to claim it.", { needKey: true });
    if (!isAdminName(name)) await screenName(name);
    if (findPlayer(name)) fail(409, "That name is taken"); // someone grabbed it while the AI was checking
    if (!allowSignup(ip)) fail(429, "Too many new players from your network — try again later");
    const p = { name, elo: 1200, games: 0, wins: 0, losses: 0, draws: 0, token: crypto.randomBytes(16).toString("hex"),
      createdAt: Date.now(), lastIp: ip };
    if (isAdminName(name)) p.admin = true;
    players[name] = p;
    tokens.set(p.token, p);
    savePlayers();
    return { ...publicPlayer(p), token: p.token };
  },

  quick(body, me) {
    if (activeGameOf(me)) fail(409, "You already have a game going");
    if (!Object.hasOwn(TIME_CONTROLS, String(body.tc))) fail(400, "Unknown time control");
    queue.set(me, { tc: body.tc, since: Date.now() });
    sendQueue(me);
    matchmake();
    pushLobby();
    return {};
  },

  unqueue(body, me) {
    leaveQueue(me);
    return {};
  },

  seek(body, me) {
    if (activeGameOf(me)) fail(409, "You already have a game going");
    if (!Object.hasOwn(TIME_CONTROLS, String(body.tc))) fail(400, "Unknown time control");
    leaveQueue(me);
    const color = ["w", "b", "random"].includes(body.color) ? body.color : "random";
    const g = createGame(me, body.tc, color);
    pushGame(g); pushLobby();
    return { id: g.id };
  },

  cancel(body, me) {
    const g = games.get(body.id);
    if (!g || g.creator !== me || g.status !== "open") fail(400, "Nothing to cancel");
    games.delete(g.id);
    send(me, { type: "game", game: null });
    pushLobby();
    return {};
  },

  join(body, me) {
    const g = games.get(body.id);
    if (!g || g.status !== "open") fail(404, "That game is no longer open");
    if (g.creator === me) fail(400, "You can't play yourself");
    if (isBlocked(g.creator, me) || isBlocked(me, g.creator)) fail(403, "You can't join that player's game");
    if (activeGameOf(me)) fail(409, "You already have a game going");
    leaveQueue(me);
    startGame(g, me);
    pushGame(g); pushLobby();
    return { id: g.id };
  },

  move(body, me) {
    const { g, color } = myGame(me, body.id);
    if (g.status !== "playing") fail(400, "Game is over");
    if (g.chess.turn() !== color) fail(400, "Not your turn");
    const now = Date.now();
    if (g.base && g.turnStart) {
      g.clocks[color] -= now - g.turnStart;
      if (g.clocks[color] <= 0) { g.clocks[color] = 0; endGame(g, color === "w" ? 0 : 1, "timeout"); return {}; }
    }
    const mv = g.chess.move({ from: body.from, to: body.to, promotion: body.promotion || "q" });
    if (!mv) fail(400, "Illegal move");
    if (g.base && g.turnStart) g.clocks[color] += g.inc;
    if (g.turnStart) g.moveTimes[color].push(now - g.turnStart);
    // Clocks start once White has made the first move
    g.turnStart = now;
    if (g.drawOffer && g.drawOffer !== color) g.drawOffer = null;
    checkPositionEnd(g);
    if (g.status === "playing") pushGame(g);
    return {};
  },

  resign(body, me) {
    const { g, color } = myGame(me, body.id);
    if (!color || g.status !== "playing") fail(400, "Can't resign now");
    if (g.chess.history().length < 2) endGame(g, null, "aborted");
    else endGame(g, color === "w" ? 0 : 1, "resignation");
    return {};
  },

  draw(body, me) {
    const { g, color } = myGame(me, body.id);
    if (!color || g.status !== "playing") fail(400, "Can't offer a draw now");
    if (g.drawOffer && g.drawOffer !== color) endGame(g, 0.5, "agreement");
    else { g.drawOffer = color; pushGame(g); }
    return {};
  },

  decline(body, me) {
    const { g, color } = myGame(me, body.id);
    if (g.drawOffer && g.drawOffer !== color) { g.drawOffer = null; pushGame(g); }
    return {};
  },

  // Players can't message each other at all
  chat() {
    fail(410, "Chat is turned off");
  },

  rematch(body, me) {
    const { g, color } = myGame(me, body.id);
    if (!color || g.status !== "over" || g.next) fail(400, "Can't rematch now");
    g.rematch.add(me);
    if (g.rematch.size === 2) {
      const other = color === "w" ? g.black : g.white;
      if (activeGameOf(me) || activeGameOf(other)) fail(409, "One of you is already in another game");
      leaveQueue(me); leaveQueue(other);
      // Swap colors
      const n = createGame(g.white, g.tc, "b");
      startGame(n, g.black);
      g.next = n.id;
      pushGame(g);
      pushGame(n);
      pushLobby();
    } else {
      pushGame(g);
    }
    return {};
  },

  friendRequest(body, me) {
    const them = findPlayer(body.name);
    if (!them) fail(404, "No player with that name");
    if (them.name === me) fail(400, "That's you!");
    if (friendsOf(me).includes(them.name)) fail(400, `You're already friends with ${them.name}`);
    if (isBlocked(them.name, me) || isBlocked(me, them.name)) fail(403, "You can't send a request to that player");
    // They already asked us: just become friends
    if (requestsOf(me).includes(them.name)) return actions.friendAccept({ name: them.name }, me);
    const reqs = requestsOf(them.name);
    if (!reqs.includes(me)) {
      if (reqs.length >= 50) fail(429, `${them.name} has too many pending requests`);
      reqs.push(me);
      savePlayers();
    }
    pushFriends(me, them.name);
    return { name: them.name, friends: false };
  },

  friendAccept(body, me) {
    const them = findPlayer(body.name);
    const reqs = requestsOf(me);
    if (!them || !reqs.includes(them.name)) fail(400, "No request from that player");
    reqs.splice(reqs.indexOf(them.name), 1);
    // Drop a crossed request in the other direction too
    const theirs = requestsOf(them.name);
    if (theirs.includes(me)) theirs.splice(theirs.indexOf(me), 1);
    if (!friendsOf(me).includes(them.name)) friendsOf(me).push(them.name);
    if (!friendsOf(them.name).includes(me)) friendsOf(them.name).push(me);
    savePlayers();
    pushFriends(me, them.name);
    return { name: them.name, friends: true };
  },

  friendDecline(body, me) {
    const reqs = requestsOf(me);
    const them = findPlayer(body.name);
    if (them && reqs.includes(them.name)) { reqs.splice(reqs.indexOf(them.name), 1); savePlayers(); }
    // Also lets you cancel a request you sent
    if (them && requestsOf(them.name).includes(me)) { requestsOf(them.name).splice(requestsOf(them.name).indexOf(me), 1); savePlayers(); }
    pushFriends(me, them && them.name);
    return {};
  },

  friendRemove(body, me) {
    const them = findPlayer(body.name);
    if (!them) fail(404, "No player with that name");
    players[me].friends = friendsOf(me).filter((n) => n !== them.name);
    them.friends = friendsOf(them.name).filter((n) => n !== me);
    savePlayers();
    for (const c of challenges.values()) {
      if ((c.from === me && c.to === them.name) || (c.to === me && c.from === them.name)) challenges.delete(c.id);
    }
    // pushFriends only reaches current friends, so tell both directly
    send(me, friendsView(me));
    send(them.name, friendsView(them.name));
    return {};
  },

  challenge(body, me) {
    const them = findPlayer(body.name);
    if (!them || !friendsOf(me).includes(them.name)) fail(400, "You can only challenge friends");
    if (isBlocked(them.name, me) || isBlocked(me, them.name)) fail(403, "You can't challenge that player");
    if (!Object.hasOwn(TIME_CONTROLS, String(body.tc))) fail(400, "Unknown time control");
    if (!online(them.name)) fail(409, `${them.name} isn't online`);
    if (activeGameOf(them.name)) fail(409, `${them.name} is in a game right now`);
    if (activeGameOf(me)) fail(409, "Finish or cancel your current game first");
    dropChallenges(me); // one challenge at a time
    const c = { id: newId(), from: me, to: them.name, tc: body.tc, at: Date.now() };
    challenges.set(c.id, c);
    leaveQueue(me);
    pushFriends(me, them.name);
    return { id: c.id };
  },

  challengeAccept(body, me) {
    const c = challenges.get(body.id);
    if (!c || c.to !== me) fail(404, "That challenge is gone");
    if (activeGameOf(me) || activeGameOf(c.from)) fail(409, "One of you is already in a game");
    if (!online(c.from)) fail(409, `${c.from} went offline`);
    challenges.delete(c.id);
    leaveQueue(me); leaveQueue(c.from);
    const g = createGame(c.from, c.tc, "random");
    startGame(g, me);
    pushGame(g); pushLobby();
    return { id: g.id };
  },

  challengeDecline(body, me) {
    const c = challenges.get(body.id);
    if (c && (c.to === me || c.from === me)) {
      challenges.delete(c.id);
      pushFriends(c.from, c.to);
    }
    return {};
  },

  // Names are permanent except for one change every 180 days
  async rename(body, me) {
    const p = players[me];
    const name = String(body.name || "").trim();
    if (!NAME_RULE.test(name)) fail(400, "Names are 2–20 letters, numbers, spaces, _ or -");
    if (name === me) fail(400, "That's already your name");
    if (!p.admin) await screenName(name, me);
    const next = (p.nameChangedAt || 0) + NAME_COOLDOWN_MS;
    if (Date.now() < next) fail(429, `You can change your name again on ${new Date(next).toDateString()}`);
    const taken = findPlayer(name);
    if (taken && taken !== p) fail(409, "That name is taken");
    if (isAdminName(name) && !p.admin) fail(409, "That name is reserved");
    if (activeGameOf(me)) fail(409, "Finish your current game first");
    leaveQueue(me);
    dropChallenges(me);
    p.nameChangedAt = Date.now();
    renamePlayer(p, name);
    return meView(p);
  },

  // ---------- admin (only the admin account can call these) ----------

  adminSearch(body, me) {
    requireAdmin(me);
    const q = String(body.q || "").trim().toLowerCase();
    const order = { online: 0, playing: 1, offline: 2 };
    return {
      players: Object.values(players)
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .map((p) => ({ ...publicPlayer(p), status: playerStatus(p.name), admin: !!p.admin,
          banned: !!p.ban, restrictedUntil: p.restriction && p.restriction.until > Date.now() ? p.restriction.until : null }))
        .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
        .slice(0, 100),
    };
  },

  adminPlayer(body, me) {
    const p = adminTarget(body, me, { notAdmin: false });
    const g = activeGameOf(p.name);
    return {
      name: p.name, elo: Math.round(p.elo), games: p.games, wins: p.wins || 0, losses: p.losses || 0, draws: p.draws || 0,
      admin: !!p.admin, createdAt: p.createdAt || null, status: playerStatus(p.name),
      lastSeenAt: online(p.name) ? Date.now() : p.lastSeenAt || lastSeen.get(p.name) || null, lastIp: p.lastIp || null,
      nameChangedAt: p.nameChangedAt || null,
      ban: p.ban || null, restriction: p.restriction && p.restriction.until > Date.now() ? p.restriction : null,
      sanctionLog: p.sanctionLog || [],
      friends: friendsOf(p.name).filter((n) => players[n]).map((n) => ({ name: n, status: playerStatus(n) })),
      requests: requestsOf(p.name),
      history: p.history || [], chatLog: p.chatLog || [],
      ai: p.aiRecent && p.aiRecent.length ? { games: p.aiRecent.length, flagged: p.aiRecent.filter((r) => r.flag).length, ...anticheat.combine(p.aiRecent) } : null,
      reports: reports.filter((r) => r.player === p.name).slice(0, 20),
      currentGame: g ? { id: g.id, status: g.status, tc: g.tc, white: g.white, black: g.black,
        moves: g.chess.history().length, pgn: g.chess.pgn(), chat: g.chat.slice(-30) } : null,
    };
  },

  adminReports(body, me) {
    requireAdmin(me);
    const status = ["open", "dismissed", "resolved", "all"].includes(body.status) ? body.status : "open";
    const list = reports.filter((r) => status === "all" || r.status === status)
      .sort((a, b) => (b.status === "open") - (a.status === "open") || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((r) => ({ ...r, playerExists: !!findPlayer(r.player), banned: !!(findPlayer(r.player) || {}).ban }));
    return { reports: list, open: openReports().length };
  },

  adminReportUpdate(body, me) {
    requireAdmin(me);
    const r = reports.find((x) => x.id === body.id);
    if (!r) fail(404, "Report not found");
    if (!["open", "dismissed", "resolved"].includes(body.status)) fail(400, "Unknown status");
    r.status = body.status;
    r.updatedAt = Date.now();
    r.handledBy = me;
    saveReports();
    notifyAdmins();
    return { ok: true };
  },

  adminKick(body, me) {
    const p = adminTarget(body, me);
    const reason = String(body.reason || "").trim().slice(0, 200);
    logSanction(p, "kick", me, { reason });
    savePlayers();
    removePlayer(p.name, { kind: "kick", message: `You were kicked by an admin.${reason ? ` Reason: ${reason}` : ""} You can come back by reloading the page.` });
    return { ok: true };
  },

  adminBan(body, me) {
    const p = adminTarget(body, me);
    const reason = String(body.reason || "").trim().slice(0, 200);
    const ip = body.blockIp && p.lastIp ? p.lastIp : null;
    p.ban = { at: Date.now(), by: me, reason, ip };
    if (ip) bannedIps.add(ip);
    logSanction(p, "ban", me, { reason, ipBlocked: !!ip });
    savePlayers();
    removePlayer(p.name, { kind: "ban", message: sanctionOf(p).message });
    return { ok: true };
  },

  adminUnban(body, me) {
    const p = adminTarget(body, me);
    if (!p.ban) fail(400, `${p.name} isn't banned`);
    if (p.ban.ip && !Object.values(players).some((o) => o !== p && o.ban && o.ban.ip === p.ban.ip)) bannedIps.delete(p.ban.ip);
    delete p.ban;
    logSanction(p, "unban", me);
    savePlayers();
    return { ok: true };
  },

  adminRestrict(body, me) {
    const p = adminTarget(body, me);
    const minutes = Math.round(+body.minutes);
    if (!(minutes >= 1 && minutes <= 10 * 365 * 24 * 60)) fail(400, "Pick a time between 1 minute and 10 years");
    const reason = String(body.reason || "").trim().slice(0, 200);
    p.restriction = { at: Date.now(), by: me, reason, until: Date.now() + minutes * 60_000 };
    logSanction(p, "restrict", me, { reason, minutes, until: p.restriction.until });
    savePlayers();
    removePlayer(p.name, { kind: "restriction", message: sanctionOf(p).message, until: p.restriction.until, reason });
    return { ok: true, until: p.restriction.until };
  },

  adminUnrestrict(body, me) {
    const p = adminTarget(body, me);
    if (!p.restriction) fail(400, `${p.name} isn't restricted`);
    delete p.restriction;
    logSanction(p, "unrestrict", me);
    savePlayers();
    return { ok: true };
  },

  // Set a player's rating directly (e.g. someone sandbagging or boosted)
  adminSetElo(body, me) {
    const p = adminTarget(body, me, { notAdmin: false });
    const elo = Math.round(+body.elo);
    if (!(elo >= 100 && elo <= 3300)) fail(400, "Pick a rating between 100 and 3300");
    const reason = String(body.reason || "").trim().slice(0, 200);
    const from = Math.round(p.elo);
    p.elo = elo;
    logSanction(p, "set elo", me, { reason, from: String(from), to: String(elo) });
    savePlayers();
    send(p.name, { type: "me", me: meView(p) });
    if (p.name !== me) send(p.name, { type: "notice", text: `An admin changed your rating from ${from} to ${elo}.${reason ? ` Reason: ${reason}` : ""}` });
    pushLobby();
    pushFriends(p.name);
    return { ok: true, elo };
  },

  adminRename(body, me) {
    const p = adminTarget(body, me, { notAdmin: false });
    const name = String(body.newName || "").trim();
    if (!NAME_RULE.test(name)) fail(400, "Names are 2–20 letters, numbers, spaces, _ or -");
    if (name === p.name) fail(400, "That's already their name");
    const rule = checkName(name, { allowStaffNames: p.admin });
    if (!rule.ok) fail(400, rule.reason);
    const taken = findPlayer(name);
    if (taken && taken !== p) fail(409, "That name is taken");
    if (isAdminName(name) && !p.admin) fail(409, "That name is reserved");
    const old = p.name;
    logSanction(p, "rename", me, { from: old, to: name });
    renamePlayer(p, name);
    if (old !== me) send(name, { type: "notice", text: `An admin changed your name from ${old} to ${name}.` });
    return { ok: true, name };
  },

  // Report a player to the admin (shows up in the Admin tab's reports)
  reportPlayer(body, me) {
    const them = findPlayer(body.name);
    if (!them) fail(404, "No player with that name");
    if (them.name === me) fail(400, "That's you!");
    const reason = String(body.reason || "").trim().slice(0, 300) || "No reason given";
    const g = body.gameId && games.get(body.gameId);
    const lines = g ? g.chat.filter((c) => c.from === them.name).slice(-5).map((c) => `"${c.text}"`).join(" · ") : "";
    addReport({ kind: "player-report", severity: "medium", player: them.name,
      summary: `Reported by ${me}: ${reason}${lines ? ` — their recent chat: ${lines}` : ""}`, gameId: g ? g.id : null,
      dedupeKey: `player-report:${them.name}:${me}` });
    return { ok: true };
  },

  // Block or unblock a player: no chat, matches, friend requests or challenges between you
  block(body, me) {
    const them = findPlayer(body.name);
    if (!them) fail(404, "No player with that name");
    if (them.name === me) fail(400, "That's you!");
    const p = players[me];
    const list = p.blocked || (p.blocked = []);
    if (body.unblock) p.blocked = list.filter((n) => n !== them.name);
    else if (!list.includes(them.name)) list.push(them.name);
    if (!body.unblock) {
      // Blocking also ends any friendship and pending requests or challenges
      p.friends = friendsOf(me).filter((n) => n !== them.name);
      them.friends = friendsOf(them.name).filter((n) => n !== me);
      p.requests = requestsOf(me).filter((n) => n !== them.name);
      them.requests = requestsOf(them.name).filter((n) => n !== me);
      for (const c of challenges.values()) if ((c.from === me && c.to === them.name) || (c.to === me && c.from === them.name)) challenges.delete(c.id);
    }
    savePlayers();
    send(me, { type: "me", me: meView(p) });
    send(me, friendsView(me));
    send(them.name, friendsView(them.name));
    return { ok: true, blocked: p.blocked };
  },

  leave(body, me) {
    // Stop following a finished game
    const g = games.get(body.id);
    if (g && g.status === "over" && g.rematch.delete(me)) pushGame(g);
    send(me, { type: "game", game: null });
    return {};
  },
};

// ---------- http ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  let rel;
  // A malformed %-code (like /%E0%A4%A) makes decodeURIComponent throw
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400); return res.end("Bad request"); }
  if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, path.normalize(rel));
  // Never serve player data or the admin key — the default data folder is
  // blocked even when DATA_DIR points somewhere else
  const privateDirs = [DATA_DIR, path.join(ROOT, "data")].map((d) => path.resolve(d).toLowerCase());
  const lower = path.resolve(file).toLowerCase();
  if (!file.startsWith(ROOT + path.sep) || privateDirs.some((d) => lower === d || lower.startsWith(d + path.sep)) || file === __filename) {
    res.writeHead(404); return res.end("Not found");
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function openStream(req, res, url) {
  const me = byToken(url.searchParams.get("token"));
  if (!me) { res.writeHead(401); return res.end(); }
  if (sanctionOf(me)) { res.writeHead(403); return res.end(); }
  me.lastSeenAt = Date.now();
  // Broken connections must never take the server down
  res.on("error", () => {});
  req.on("error", () => {});
  // A handful of tabs per player is plenty; refuse floods of connections
  if ((streams.get(me.name)?.size || 0) >= 8) { res.writeHead(429); return res.end(); }
  // X-Accel-Buffering stops reverse proxies on hosting platforms from holding events back
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`data: ${JSON.stringify({ type: "me", me: meView(me) })}\n\n`);
  if (!streams.has(me.name)) streams.set(me.name, new Set());
  streams.get(me.name).add(res);
  const g = activeGameOf(me.name);
  res.write(`data: ${JSON.stringify({ type: "game", game: g ? gameView(g) : null })}\n\n`);
  sendQueue(me.name);
  if (me.admin) res.write(`data: ${JSON.stringify({ type: "reports", open: openReports().length })}\n\n`);
  pushLobby();
  pushFriends(me.name); // sends our list, and friends see us come online
  if (g) pushGame(g); // opponent sees us come back online
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n"); }, 20_000);
  req.on("close", () => {
    clearInterval(ping);
    streams.get(me.name)?.delete(res);
    if (!online(me.name)) {
      lastSeen.set(me.name, Date.now());
      me.lastSeenAt = Date.now();
      queue.delete(me.name);
      dropChallenges(me.name);
      pushFriends(me.name);
    }
    pushLobby();
    const ag = activeGameOf(me.name);
    if (ag) pushGame(ag);
  });
}

http.createServer((req, res) => {
  // Any unexpected error in one request answers 500 instead of stopping the server
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error("[request error]", err);
    if (!res.headersSent) { res.writeHead(500); res.end("Server error"); }
    else res.destroy();
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Elo Ladder running:`);
  console.log(`  this computer:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  same Wi-Fi:      http://${ip}:${PORT}`);
  console.log(ADMIN_NAME ? `  admin account:  ${ADMIN_NAME} (key for new devices is in ${path.relative(ROOT, ADMIN_KEY_FILE)})` : "  admin account:  none");
});

// The player's real network address. Headers like X-Forwarded-For can be
// faked by anyone, so they're only trusted when they come from a proxy we run:
// a Cloudflare tunnel on this computer (CF-Connecting-IP), or a hosting
// platform when TRUST_PROXY is set (the last X-Forwarded-For entry is the
// one the platform added).
function clientIp(req) {
  const direct = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const fromThisComputer = direct === "127.0.0.1" || direct === "::1";
  if (fromThisComputer && req.headers["cf-connecting-ip"]) return String(req.headers["cf-connecting-ip"]).trim();
  if (process.env.TRUST_PROXY && req.headers["x-forwarded-for"]) {
    const hops = String(req.headers["x-forwarded-for"]).split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return direct;
}

function handleRequest(req, res) {
  res.on("error", () => {});
  req.on("error", () => {});
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/events") return openStream(req, res, url);
  if (url.pathname === "/api/share") {
    // Addresses other devices on the same network can use (for the phone QR code)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ lan: lanAddresses().map((ip) => `http://${ip}:${PORT}`) }));
  }
  if (url.pathname === "/api/health") {
    // Open to any origin so a copy of the page served elsewhere (e.g. Live Server) can find us
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ app: "elo-ladder" }));
  }
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10_000) req.destroy(); });
    req.on("end", () => {
      const reply = (status, obj) => {
        if (res.headersSent || res.destroyed) return; // client already gone
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const onError = (err) => {
        if (!(err instanceof HttpError)) console.error(err);
        reply(err.status || 500, err instanceof HttpError ? { error: err.message, ...err.extra } : { error: "Server error" });
      };
      try {
        const name = url.pathname.slice(5);
        const action = Object.hasOwn(actions, name) && actions[name];
        if (!action) fail(404, "Unknown action");
        let data;
        try { data = body ? JSON.parse(body) : {}; } catch { fail(400, "Bad request"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Bad request");
        // Actions expect text and numbers; anything else (objects, arrays) is junk
        for (const k of Object.keys(data)) if (data[k] !== null && typeof data[k] === "object") fail(400, "Bad request");
        const me = byToken(req.headers["x-token"]);
        if (action !== actions.login && !me) fail(401, "Log in first");
        const ip = clientIp(req);
        if (me && action !== actions.login) {
          refuseIfSanctioned(me);
          me.lastIp = ip;
        }
        Promise.resolve(action(data, me && me.name, ip)).then((r) => reply(200, r), onError);
      } catch (err) {
        onError(err);
      }
    });
    return;
  }
  serveStatic(req, res);
}

// Last-resort safety net: log anything nothing else caught and keep serving
// instead of letting one mistake disconnect every player.
process.on("uncaughtException", (err) => console.error("[uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[unhandled promise]", err));

// Names created before the name rules existed get reported once for review
for (const p of Object.values(players)) {
  if (p.admin || p.nameScanned) continue;
  const rule = checkName(p.name);
  if (!rule.ok) addReport({ kind: "name", severity: "low", player: p.name, summary: `Existing name breaks the name rules: ${rule.reason}.` });
  p.nameScanned = true;
}
savePlayers();

function lanAddresses() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254.")) ips.push(n.address);
  }
  return ips;
}
