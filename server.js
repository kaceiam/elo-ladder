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

const PORT = +process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const ABANDON_MS = 60_000; // disconnected this long mid-game = loss
const TIME_CONTROLS = { "3+2": [3, 2], "5+0": [5, 0], "10+0": [10, 0], "15+10": [15, 10], "none": [0, 0] };

// ---------- players ----------

let players = {};
try { players = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")); } catch {}

let saveTimer = null;
function savePlayers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PLAYERS_FILE + ".tmp", JSON.stringify(players, null, 1));
    fs.renameSync(PLAYERS_FILE + ".tmp", PLAYERS_FILE);
  }, 200);
}

const tokens = new Map(Object.values(players).map((p) => [p.token, p]));
const byToken = (token) => token && tokens.get(token);
const publicPlayer = (p) => ({ name: p.name, elo: Math.round(p.elo), games: p.games });

// ---------- connections ----------

const streams = new Map(); // name -> Set of SSE responses
const lastSeen = new Map(); // name -> time the last stream closed

function send(name, msg) {
  for (const res of streams.get(name) || []) res.write(`data: ${JSON.stringify(msg)}\n\n`);
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
      if (b === a || paired.has(b) || qb.tc !== qa.tc) continue;
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
  };
  games.set(g.id, g);
  return g;
}

function startGame(g, joiner) {
  const color = g.creatorColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : g.creatorColor;
  g.white = color === "w" ? g.creator : joiner;
  g.black = color === "w" ? joiner : g.creator;
  g.status = "playing";
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
    savePlayers();
  }
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

// Widening rating windows can create new pairings as time passes;
// unanswered friend challenges expire
setInterval(() => {
  matchmake();
  for (const c of challenges.values()) {
    if (Date.now() - c.at > CHALLENGE_MS) { challenges.delete(c.id); pushFriends(c.from, c.to); }
  }
}, 1000);

// Flag falls and abandoned games
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    if (g.status === "open" && !online(g.creator) && now - (lastSeen.get(g.creator) || now) > ABANDON_MS) {
      games.delete(g.id);
      pushLobby();
      continue;
    }
    if (g.status !== "playing") continue;
    if (g.base && g.turnStart) {
      const t = g.chess.turn();
      if (g.clocks[t] - (now - g.turnStart) <= 0) {
        endGame(g, t === "w" ? 0 : 1, "timeout");
        continue;
      }
    }
    for (const [name, color] of [[g.white, "w"], [g.black, "b"]]) {
      if (!online(name) && now - (lastSeen.get(name) || now) > ABANDON_MS) {
        if (g.chess.history().length < 2) endGame(g, null, "aborted — player left");
        else endGame(g, color === "w" ? 0 : 1, "abandoned");
        break;
      }
    }
  }
}, 250);

// ---------- actions ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

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
  login(body, me, ip) {
    const name = String(body.name || "").trim();
    if (!/^[A-Za-z0-9 _-]{2,20}$/.test(name)) fail(400, "Names are 2–20 letters, numbers, spaces, _ or -");
    const key = Object.keys(players).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) {
      if (players[key].token !== body.token) fail(409, "That name is taken");
      return { ...publicPlayer(players[key]), token: players[key].token };
    }
    if (!allowSignup(ip)) fail(429, "Too many new players from your network — try again later");
    const p = { name, elo: 1200, games: 0, wins: 0, losses: 0, draws: 0, token: crypto.randomBytes(16).toString("hex") };
    players[name] = p;
    tokens.set(p.token, p);
    savePlayers();
    return { ...publicPlayer(p), token: p.token };
  },

  quick(body, me) {
    if (activeGameOf(me)) fail(409, "You already have a game going");
    if (!TIME_CONTROLS[body.tc]) fail(400, "Unknown time control");
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
    if (!TIME_CONTROLS[body.tc]) fail(400, "Unknown time control");
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

  chat(body, me) {
    const { g, color } = myGame(me, body.id);
    const text = String(body.text || "").trim().slice(0, 300);
    if (!color || !text) fail(400, "Nothing to send");
    if (Date.now() - (lastChat.get(me) || 0) < 700) fail(429, "Slow down");
    lastChat.set(me, Date.now());
    g.chat.push({ from: me, text, at: Date.now() });
    pushGame(g);
    return {};
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
    if (!TIME_CONTROLS[body.tc]) fail(400, "Unknown time control");
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
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/online.html";
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR) || file === __filename) {
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
  // X-Accel-Buffering stops reverse proxies on hosting platforms from holding events back
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`data: ${JSON.stringify({ type: "me", me: publicPlayer(me) })}\n\n`);
  if (!streams.has(me.name)) streams.set(me.name, new Set());
  streams.get(me.name).add(res);
  const g = activeGameOf(me.name);
  res.write(`data: ${JSON.stringify({ type: "game", game: g ? gameView(g) : null })}\n\n`);
  sendQueue(me.name);
  pushLobby();
  pushFriends(me.name); // sends our list, and friends see us come online
  if (g) pushGame(g); // opponent sees us come back online
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    streams.get(me.name).delete(res);
    if (!online(me.name)) {
      lastSeen.set(me.name, Date.now());
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
      const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      try {
        const action = actions[url.pathname.slice(5)];
        if (!action) fail(404, "Unknown action");
        const data = body ? JSON.parse(body) : {};
        const me = byToken(req.headers["x-token"]);
        if (action !== actions.login && !me) fail(401, "Log in first");
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();
        reply(200, action(data, me && me.name, ip));
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        reply(err.status || 500, { error: err instanceof HttpError ? err.message : "Server error" });
      }
    });
    return;
  }
  serveStatic(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Elo Ladder running:`);
  console.log(`  this computer:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  same Wi-Fi:      http://${ip}:${PORT}`);
});

function lanAddresses() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254.")) ips.push(n.address);
  }
  return ips;
}
