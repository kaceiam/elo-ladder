// Anti-cheat analysis: replays finished games through Stockfish (running in
// a child process) and measures, for each player, how close their moves were
// to the engine's: accuracy (Lichess's formula — how much of their winning
// chance each move kept, 0–100%), average centipawn loss, and how often they
// played the engine's exact top move. Humans make small mistakes all the time;
// a 1200 player whose moves match the engine almost every time is very likely
// using one.

const { spawn } = require("child_process");
const path = require("path");
const { Chess } = require("./vendor/chess.min.js");

const SF_PATH = path.join(__dirname, "vendor", "stockfish", "stockfish-18-lite-single.js");
const MOVETIME_MS = 120;   // per position; ~10 s for a 40-move game
const SKIP_OPENING = 10;   // plies of opening theory not counted
const ACPL_CAP_CP = 1000;  // centipawn loss only counted while the game is still close-ish
const MATE = 10_000;

class Engine {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.waiter = null;
  }
  start() {
    if (this.proc) return;
    this.proc = spawn(process.execPath, [SF_PATH], { stdio: ["pipe", "pipe", "ignore"] });
    // If the engine dies or can't start, analysis fails quietly instead of crashing the server
    this.proc.on("error", () => { this.proc = null; if (this.waiter) this.waiter(null); });
    this.proc.stdin.on("error", () => {});
    this.proc.stdout.on("data", (d) => {
      this.buf += d;
      const lines = this.buf.split("\n");
      this.buf = lines.pop();
      for (const l of lines) if (this.waiter) this.waiter(l.trim());
    });
    this.proc.on("exit", () => { this.proc = null; if (this.waiter) this.waiter(null); });
  }
  // Send commands; resolve with the first line `done` accepts
  request(cmds, done, onLine) {
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error("engine timeout")); }, 15_000);
      this.waiter = (line) => {
        if (line === null) { clearTimeout(timer); this.waiter = null; return reject(new Error("engine exited")); }
        if (onLine) onLine(line);
        if (done(line)) { clearTimeout(timer); this.waiter = null; resolve(line); }
      };
      if (!this.proc) { clearTimeout(timer); this.waiter = null; return reject(new Error("engine unavailable")); }
      this.proc.stdin.write(cmds.join("\n") + "\n");
    });
  }
  async evaluate(fen) {
    let score = 0;
    const line = await this.request([`position fen ${fen}`, `go movetime ${MOVETIME_MS}`], (l) => l.startsWith("bestmove"), (l) => {
      const m = l.match(/score (cp|mate) (-?\d+)/);
      if (m) score = m[1] === "cp" ? +m[2] : Math.sign(+m[2]) * (MATE - Math.abs(+m[2]));
    });
    return { best: line.split(" ")[1], score };
  }
  stop() { if (this.proc) this.proc.kill(); }
}

const engine = new Engine();
let chain = Promise.resolve();

// moves: [{from, to, promotion}] in order. Returns per-color stats.
function analyzeGame(moves) {
  const run = async () => {
    await engine.request(["ucinewgame", "setoption name UCI_LimitStrength value false", "setoption name Skill Level value 20", "isready"], (l) => l === "readyok");
    const game = new Chess();
    const evals = [];
    const played = [];
    const positionEval = async () => {
      if (game.in_checkmate()) return { best: null, score: -MATE };
      if (game.game_over()) return { best: null, score: 0 };
      return engine.evaluate(game.fen());
    };
    evals.push(await positionEval());
    for (const m of moves) {
      const mv = game.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
      if (!mv) break;
      played.push(mv.from + mv.to + (mv.promotion || ""));
      evals.push(await positionEval());
    }
    const stats = { w: { moves: 0, acc: 0, matches: 0, lossMoves: 0, loss: 0 }, b: { moves: 0, acc: 0, matches: 0, lossMoves: 0, loss: 0 } };
    for (let i = SKIP_OPENING; i < played.length; i++) {
      const color = i % 2 === 0 ? "w" : "b";
      const before = evals[i].score;           // mover's view, best play
      const after = -evals[i + 1].score;       // mover's view, after their move
      const s = stats[color];
      s.moves++;
      s.acc += moveAccuracy(before, after);
      if (evals[i].best && played[i] === evals[i].best) s.matches++;
      if (Math.abs(before) <= ACPL_CAP_CP) { s.lossMoves++; s.loss += Math.min(1000, Math.max(0, before - after)); }
    }
    const out = {};
    for (const c of ["w", "b"]) {
      const s = stats[c];
      out[c] = { moves: s.moves, accuracy: s.moves ? Math.round(s.acc / s.moves) : null,
        match: s.moves ? s.matches / s.moves : null, acpl: s.lossMoves ? Math.round(s.loss / s.lossMoves) : null };
    }
    return out;
  };
  const result = chain.then(run);
  chain = result.catch(() => {});
  return result;
}

// Lichess-style: centipawns -> winning chance (0-100), then how much of it a move kept
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-MATE, Math.min(MATE, cp)))) - 1);
function moveAccuracy(beforeCp, afterCp) {
  const drop = winPct(beforeCp) - winPct(afterCp);
  if (drop <= 0) return 100;
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}
// Typical accuracy for a human at a rating (rough)
const typicalAccuracy = (elo) => Math.round(Math.min(90, 55 + elo * 0.012));

// Coefficient of variation of think times: very low = suspiciously steady
function timingSteadiness(times) {
  const t = (times || []).filter((x) => x > 300);
  if (t.length < 12) return null;
  const mean = t.reduce((a, b) => a + b, 0) / t.length;
  const sd = Math.sqrt(t.reduce((a, b) => a + (b - mean) ** 2, 0) / t.length);
  return sd / mean;
}

// Judge one player's stats — a single game, or several added together.
// The engine-match rate is the main signal; accuracy and centipawn loss back
// it up (a hopeless position scores high "accuracy" whatever you play).
// Returns null, or { severity, summary }.
function judge(stat, elo, times, { label = "game" } = {}) {
  if (!stat || stat.moves < 12 || stat.match === null) return null;
  const pct = Math.round(stat.match * 100);
  const steady = timingSteadiness(times);
  const steadyNote = steady !== null && steady < 0.35 ? " Their thinking time was almost the same every move." : "";
  const lossNote = stat.acpl !== null ? `, average loss ${stat.acpl}` : "";
  const base = `played the engine's top move ${pct}% of the time over ${stat.moves} moves, ${stat.accuracy}% accuracy${lossNote} ` +
    `(a typical ${Math.round(elo)} player gets ~${typicalAccuracy(elo)}% and matches the engine ~35–45% of the time).`;
  const lowLoss = (max) => stat.acpl === null || stat.acpl <= max;
  if (stat.match >= 0.75 && stat.accuracy >= 92 && lowLoss(15) && elo < 2400) return { severity: "high", summary: `Plays like a chess engine — in this ${label} they ${base}${steadyNote}` };
  if (stat.match >= 0.65 && stat.accuracy >= 88 && lowLoss(25) && elo < 2000) return { severity: "medium", summary: `Suspiciously accurate for their rating — in this ${label} they ${base}${steadyNote}` };
  return null;
}

// Add several games' stats together (weighted by moves)
function combine(list) {
  const t = { moves: 0, acc: 0, match: 0, lossMoves: 0, loss: 0 };
  for (const s of list) {
    if (!s || !s.moves) continue;
    t.moves += s.moves;
    t.acc += s.accuracy * s.moves;
    t.match += s.match * s.moves;
    if (s.acpl !== null) { t.lossMoves += s.moves; t.loss += s.acpl * s.moves; }
  }
  return t.moves ? { moves: t.moves, accuracy: Math.round(t.acc / t.moves), match: t.match / t.moves,
    acpl: t.lossMoves ? Math.round(t.loss / t.lossMoves) : null } : null;
}
module.exports = { analyzeGame, judge, combine, typicalAccuracy, stop: () => engine.stop() };
