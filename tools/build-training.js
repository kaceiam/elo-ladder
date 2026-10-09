// Builds the training courses (elo/training/*.json): 7 sections × 40 lessons.
//
// Puzzles come from the Lichess puzzle database (public domain, CC0):
// https://database.lichess.org/#puzzles — every puzzle there is computer-checked
// and tagged by theme. The beginner lessons on how pieces move are generated
// here and checked with chess.js.
//
//   node tools/build-training.js [path-to-cached-csv]
//
// Without a path it downloads the start of the database (one ~180k-puzzle
// chunk is plenty) and saves it next to this script as puzzles-cache.csv.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable, Transform } = require("stream");
const { Chess } = require("../vendor/chess.min.js");

const OUT = path.join(__dirname, "..", "training");
const CACHE = process.argv[2] || path.join(__dirname, "puzzles-cache.csv");
const PER_LESSON = 5;

// ---------- load puzzles ----------

async function download() {
  console.log("Downloading the first chunk of the Lichess puzzle database…");
  const res = await fetch("https://database.lichess.org/lichess_db_puzzle.csv.zst");
  // The file opens with a 12-byte zstd "skippable frame" Node's decoder rejects
  let skipped = false;
  const skip = new Transform({ transform(chunk, enc, cb) { if (!skipped) { skipped = true; chunk = chunk.subarray(12); } cb(null, chunk); } });
  const out = fs.createWriteStream(CACHE);
  await new Promise((resolve) => {
    const dec = Readable.fromWeb(res.body).pipe(skip).pipe(zlib.createZstdDecompress());
    dec.pipe(out);
    // The database is many compressed chunks; the first one is all we need
    dec.on("error", () => { out.end(); resolve(); });
    dec.on("end", resolve);
  });
}

function loadPuzzles() {
  const lines = fs.readFileSync(CACHE, "utf8").split("\n");
  const puzzles = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    if (f.length < 10) continue;
    const [id, fen, moves, rating, rd, popularity, plays, themes, , openings] = f;
    puzzles.push({
      id, fen, moves: moves.split(" "), rating: +rating, rd: +rd, popularity: +popularity, plays: +plays,
      themes: new Set(themes.split(" ")), openings: (openings || "").split(" ").filter(Boolean),
    });
  }
  return puzzles;
}

// ---------- picking puzzles ----------

const used = new Set();
let POOL = [];

// Best-quality unused puzzles matching `filter`, nearest to the target rating
function pick(filter, [lo, hi], n = PER_LESSON) {
  const target = (lo + hi) / 2;
  const good = (p) => !used.has(p.id) && filter(p) && p.popularity >= 80 && p.plays >= 150 && p.rd <= 90;
  let list = POOL.filter((p) => good(p) && p.rating >= lo && p.rating <= hi);
  // Widen the rating range if a rare theme doesn't have enough
  for (let w = 100; list.length < n && w <= 1200; w += 100) list = POOL.filter((p) => good(p) && p.rating >= lo - w && p.rating <= hi + w);
  list.sort((a, b) => Math.abs(a.rating - target) - Math.abs(b.rating - target) || b.popularity - a.popularity);
  const chosen = list.slice(0, n).sort((a, b) => a.rating - b.rating);
  if (chosen.length < n) throw new Error(`Not enough puzzles for filter ${filter} in ${lo}-${hi}`);
  for (const p of chosen) used.add(p.id);
  return chosen.map(toTask);
}

function toTask(p) {
  // Sanity-check every move with chess.js
  const g = new Chess(p.fen);
  for (const m of p.moves) {
    if (!g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] })) throw new Error(`Illegal move ${m} in puzzle ${p.id}`);
  }
  return { kind: "puzzle", fen: p.fen, moves: p.moves, rating: p.rating, id: p.id };
}

const has = (...themes) => (p) => themes.every((t) => p.themes.has(t));
const hasAny = (...themes) => (p) => themes.some((t) => p.themes.has(t));
const opening = (name) => (p) => p.openings[0] === name;

// ---------- generated beginner tasks ----------

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const SQUARES = [];
for (const r of "12345678") for (const f of "abcdefgh") SQUARES.push(f + r);
const randSq = () => SQUARES[Math.floor(rand() * 64)];

function boardFen(pieces, turn = "w", extra = "- - 0 1") {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = "", empty = 0;
    for (const f of "abcdefgh") {
      const p = pieces[f + r];
      if (p) { if (empty) row += empty; empty = 0; row += p; } else empty++;
    }
    rows.push(row + (empty || ""));
  }
  return `${rows.join("/")} ${turn} ${extra}`;
}

// Is the position legal, and is the side NOT to move out of check?
function sane(fen) {
  const g = new Chess();
  if (!g.load(fen)) return null;
  const parts = fen.split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-"; // an en passant square only makes sense for the real side to move
  const flipped = new Chess();
  if (!flipped.load(parts.join(" ")) || flipped.in_check()) return null;
  return g;
}

// "Capture the black piece with your X": only that piece can reach the target
function captureTask(pieceLetter, targetLetter = "p", prompt) {
  for (let tries = 0; tries < 5000; tries++) {
    const pieces = {};
    const wk = randSq(), bk = randSq(), from = randSq(), to = randSq();
    if (new Set([wk, bk, from, to]).size < 4) continue;
    if (pieceLetter === "P" && (from[1] === "1" || from[1] === "8")) continue;
    if (targetLetter === "p" && (to[1] === "1" || to[1] === "8")) continue;
    Object.assign(pieces, { [wk]: "K", [bk]: "k", [from]: pieceLetter, [to]: targetLetter });
    const fen = boardFen(pieces);
    const g = sane(fen);
    if (!g || g.in_check()) continue;
    const caps = g.moves({ verbose: true }).filter((m) => m.to === to);
    if (caps.length !== 1 || caps[0].from !== from) continue; // only our piece can take it
    return goalTask(fen, { type: "capture", square: to }, prompt);
  }
  throw new Error("captureTask failed " + pieceLetter);
}

function giveCheckTask(pieceLetter) {
  for (let tries = 0; tries < 5000; tries++) {
    const wk = randSq(), bk = randSq(), from = randSq();
    if (new Set([wk, bk, from]).size < 3) continue;
    if (pieceLetter === "P" && (from[1] === "1" || from[1] === "8")) continue;
    const fen = boardFen({ [wk]: "K", [bk]: "k", [from]: pieceLetter });
    const g = sane(fen);
    if (!g || g.in_check()) continue;
    const checks = g.moves({ verbose: true }).filter((m) => m.from === from && m.san.includes("+"));
    if (!checks.length) continue;
    return goalTask(fen, { type: "check" }, "Give check: attack the black king.");
  }
  throw new Error("giveCheckTask failed");
}

function escapeCheckTask() {
  for (let tries = 0; tries < 5000; tries++) {
    const wk = randSq(), bk = randSq(), att = randSq(), help = randSq();
    if (new Set([wk, bk, att, help]).size < 4) continue;
    const attacker = ["r", "b", "q", "n"][Math.floor(rand() * 4)];
    const fen = boardFen({ [wk]: "K", [bk]: "k", [att]: attacker, [help]: "R" });
    const g = new Chess();
    if (!g.load(fen) || !g.in_check() || g.in_checkmate()) continue;
    const parts = fen.split(" "); parts[1] = "b";
    const flipped = new Chess();
    if (!flipped.load(parts.join(" ")) || flipped.in_check()) continue;
    if (g.moves().length < 2) continue;
    return { kind: "goal", fen, goal: { type: "legal" }, prompt: "You're in check! Get out of it: move your king, block the attack, or capture the attacker." };
  }
  throw new Error("escapeCheckTask failed");
}

// Capture the most valuable of several undefended black pieces
function bestCaptureTask() {
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  for (let tries = 0; tries < 20000; tries++) {
    const squares = Array.from({ length: 6 }, randSq);
    if (new Set(squares).size < 6) continue;
    const [wk, bk, wq, t1, t2, t3] = squares;
    const kinds = ["p", "n", "b", "r"].sort(() => rand() - 0.5).slice(0, 3);
    if ([t1, t2, t3].some((s, i) => kinds[i] === "p" && (s[1] === "1" || s[1] === "8"))) continue;
    const pieces = { [wk]: "K", [bk]: "k", [wq]: "Q", [t1]: kinds[0], [t2]: kinds[1], [t3]: kinds[2] };
    const fen = boardFen(pieces);
    const g = sane(fen);
    if (!g || g.in_check()) continue;
    const caps = g.moves({ verbose: true }).filter((m) => m.from === wq && m.captured);
    if (caps.length < 2) continue;
    const best = caps.reduce((a, b) => (VALUE[b.captured] > VALUE[a.captured] ? b : a));
    if (caps.filter((c) => VALUE[c.captured] === VALUE[best.captured]).length > 1) continue;
    // The best capture must not just hang the queen to the black king
    const after = new Chess(fen); after.move(best);
    if (after.moves({ verbose: true }).some((m) => m.captured === "q")) continue;
    return goalTask(fen, { type: "capture", square: best.to }, "Your queen can take more than one piece. Capture the most valuable one.");
  }
  throw new Error("bestCaptureTask failed");
}

// Same rules the training page uses to accept a move
function meetsGoal(game, move, goal) {
  switch (goal.type) {
    case "move": return move.from === goal.from && move.to === goal.to;
    case "capture": return move.to === goal.square && !!move.captured;
    case "promote": return !!move.promotion;
    case "castle": return goal.side === "k" ? move.flags.includes("k") : goal.side === "q" ? move.flags.includes("q") : /[kq]/.test(move.flags);
    case "enpassant": return move.flags.includes("e");
    case "check": return game.in_check();
    case "legal": return true;
  }
  return false;
}
const goalTask = (fen, goal, prompt) => {
  if (!sane(fen) && goal.type !== "legal") throw new Error("bad fen " + fen);
  const g = new Chess(fen);
  const works = g.moves({ verbose: true }).some((m) => { g.move(m); const ok = meetsGoal(g, m, goal); g.undo(); return ok; });
  if (!works) throw new Error(`No move completes ${goal.type} in ${fen}`);
  return { kind: "goal", fen, goal, prompt };
};

// ---------- text ----------

const THEME_TEXT = {
  mateIn1: "Checkmate in one move. Look at every check you can give — one of them leaves the king with no escape.",
  mateIn2: "Checkmate in two moves. Your first move often forces the opponent's reply, then the second move delivers mate.",
  mateIn3: "Checkmate in three moves. Use checks and captures to drive the king where you want it.",
  mateIn4: "Checkmate in four moves. Long forcing sequences — keep giving checks so the opponent never gets time to defend.",
  mateIn5: "Checkmate in five or more moves. Calculate carefully: every move should be forcing.",
  backRankMate: "Back-rank mate: a king trapped behind its own pawns on the last rank is mated by a rook or queen.",
  smotheredMate: "Smothered mate: the king is surrounded by its own pieces and a knight delivers checkmate.",
  anastasiaMate: "Anastasia's mate: a knight and a rook (or queen) trap the king on the edge of the board.",
  arabianMate: "Arabian mate: a rook and a knight team up to mate a king in the corner.",
  hookMate: "Hook mate: a rook protected by a knight, which is protected by a pawn, traps the king.",
  bodenMate: "Boden's mate: two bishops on crossing diagonals mate a king, usually after castling queenside.",
  doubleBishopMate: "Double-bishop mate: two bishops working side by side checkmate the king.",
  dovetailMate: "Dovetail mate: the queen mates the king diagonally while its own pieces block its escape.",
  cornerMate: "Corner mate: a king stuck in the corner is mated by a rook and a knight.",
  epauletteMate: "Epaulette mate: pieces on both sides of the king (like shoulder pads) block its escape.",
  operaMate: "Opera mate: a rook backed up by a bishop mates the king on the back rank.",
  pillsburysMate: "Pillsbury's mate: a rook and bishop combine against a castled king.",
  morphysMate: "Morphy's mate: a bishop controls the long diagonal while a rook delivers mate.",
  triangleMate: "Triangle mate: queen and rook form a triangle around the king.",
  swallowstailMate: "Swallow's tail mate: the queen mates the king, whose escape squares are blocked by its own pieces.",
  killBoxMate: "Kill box mate: a rook next to the king, protected by the queen, boxes it in.",
  blindSwineMate: "Blind swine mate: two rooks on the 7th rank gobble up everything, including the king.",
  vukovicMate: "Vuković mate: rook and knight trap the king on the edge.",
  balestraMate: "Balestra mate: a bishop delivers mate while the queen blocks the king's escape.",
  fork: "A fork attacks two or more pieces at once. Your opponent can only save one.",
  pin: "A pin attacks a piece that can't move without exposing a more valuable piece behind it.",
  skewer: "A skewer attacks a valuable piece; when it moves, you win the piece behind it.",
  discoveredAttack: "A discovered attack: move one piece out of the way to unleash an attack by the piece behind it.",
  discoveredCheck: "A discovered check: moving one piece reveals check from another — the moved piece can grab something.",
  doubleCheck: "A double check attacks the king with two pieces at once. The king must move — nothing can block both.",
  deflection: "Deflection: force a defending piece away from the square or piece it guards.",
  attraction: "Attraction: lure an enemy piece (often the king) onto a bad square, usually with a sacrifice.",
  clearance: "Clearance: move a piece out of the way, often with tempo, to open a line or square for another piece.",
  interference: "Interference: put a piece between an enemy piece and the square it defends.",
  xRayAttack: "X-ray attack: a piece attacks or defends through another piece on the same line.",
  trappedPiece: "Trapped piece: a piece with no safe squares can be won.",
  hangingPiece: "Hanging piece: an undefended piece you can simply capture for free.",
  capturingDefender: "Capture the defender: remove the piece that guards something important.",
  sacrifice: "Sacrifice: give up material on purpose to get something bigger — an attack, checkmate, or more material back.",
  intermezzo: "In-between move (zwischenzug): before the expected recapture, play a stronger move first.",
  quietMove: "Quiet move: a move without check or capture that sets up an unstoppable threat.",
  defensiveMove: "Defensive move: the only move that saves the position. Spot the threat first.",
  zugzwang: "Zugzwang: your opponent has to move, and every move makes things worse.",
  promotion: "Promotion: push a pawn to the last rank and turn it into a queen (or another piece).",
  underPromotion: "Under-promotion: sometimes a knight, rook or bishop is better than a queen — to give check, or to avoid stalemate.",
  advancedPawn: "Advanced pawn: a pawn close to promoting ties down the opponent's pieces.",
  attackingF2F7: "Attacking f2/f7: the square next to the king, defended only by the king early on, is a classic target.",
  kingsideAttack: "Kingside attack: bring pieces toward the castled king and break through.",
  queensideAttack: "Queenside attack: attack the king that castled queenside, or win material on that side.",
  exposedKing: "Exposed king: when the king has lost its pawn shelter, attack it with everything.",
  enPassant: "En passant: capture a pawn that just moved two squares, as if it had moved one.",
  castling: "Castling: move the king to safety and bring a rook into play — sometimes it's also the winning tactic.",
  pawnEndgame: "Pawn endgames: only kings and pawns. King activity and counting moves to promotion decide the game.",
  rookEndgame: "Rook endgames: the most common endgame. Active rooks and passed pawns matter most.",
  bishopEndgame: "Bishop endgames: bishops and pawns. Remember a bishop only controls one color of squares.",
  knightEndgame: "Knight endgames: knights and pawns. Knights are slow, so tempo and forks matter.",
  queenEndgame: "Queen endgames: watch for checks, and look for ways to trade into a winning pawn endgame.",
  queenRookEndgame: "Queen and rook endgames: heavy pieces with lots of checking chances.",
  crushing: "Find the move that wins decisively — a big material gain or a mating attack.",
  advantage: "Find the move that gives you a clear advantage.",
  equality: "Find the move that saves you and keeps the game balanced.",
  middlegame: "Middlegame puzzles: tactics from real games after the opening.",
  endgame: "Endgame puzzles: fewer pieces, but precise calculation is everything.",
  long: "Longer puzzles: plan several moves ahead.",
  veryLong: "Very long puzzles: a deep combination — see it all the way to the end.",
  master: "Puzzles from games played by titled players.",
  masterVsMaster: "Puzzles from games where both players were titled players.",
  superGM: "Puzzles from games between the world's best players.",
  oneMove: "One-move puzzles: find the single best move.",
  opening: "Opening traps and tactics: punish mistakes in the first moves of the game.",
  short: "Short puzzles: two or three moves deep.",
};

const levelName = (i) => ["", " I", " II", " III", " IV", " V", " VI"][i] || ` ${i}`;
const pretty = (s) => s.replace(/_/g, " ").replace(/s Gambit/, "'s Gambit").replace(/Kings /, "King's ").replace(/Queens /, "Queen's ").replace(/Bishops /, "Bishop's ").replace(/Petrovs /, "Petrov's ");

function themeLesson(title, theme, range, extra = "", filter = has(theme)) {
  return { title, intro: `${THEME_TEXT[theme] || ""}${extra ? " " + extra : ""}`.trim(), tasks: pick(filter, range) };
}

// ---------- the sections ----------

function section1() {
  const L = [];
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  L.push({ title: "Your first moves", intro: "The board has 8 files (a–h) and 8 ranks (1–8). White moves first. Pawns move straight forward: two squares on their first move, one square after that. Knights jump in an L shape.",
    tasks: [
      goalTask(start, { type: "move", from: "e2", to: "e4" }, "Move the e-pawn forward two squares: e2 to e4."),
      goalTask(start, { type: "move", from: "g1", to: "f3" }, "Move the knight from g1 to f3."),
      goalTask(start, { type: "move", from: "d2", to: "d3" }, "Move the d-pawn forward just one square: d2 to d3."),
      goalTask(start, { type: "move", from: "b1", to: "c3" }, "Move the knight from b1 to c3."),
      goalTask(start, { type: "move", from: "c2", to: "c4" }, "Move the c-pawn forward two squares: c2 to c4."),
    ] });
  const pieceLesson = (title, letter, intro, prompt) => ({ title, intro, tasks: Array.from({ length: 5 }, () => captureTask(letter, "p", prompt)) });
  L.push(pieceLesson("The rook", "R", "The rook (worth 5 pawns) moves any number of squares in a straight line — up, down, left or right — but can't jump over pieces. It captures the same way.", "Capture the black pawn with your rook."));
  L.push(pieceLesson("The bishop", "B", "The bishop (worth 3) moves any number of squares diagonally. Each bishop stays on one color of square for the whole game.", "Capture the black pawn with your bishop."));
  L.push(pieceLesson("The queen", "Q", "The queen (worth 9) is the strongest piece: she moves like a rook and a bishop combined — any distance in a straight line or diagonal.", "Capture the black pawn with your queen."));
  L.push(pieceLesson("The king", "K", "The king moves one square in any direction. He's the most important piece: if he's trapped (checkmate), you lose.", "Capture the black pawn with your king."));
  L.push(pieceLesson("The knight", "N", "The knight (worth 3) moves in an L: two squares one way, then one square sideways. It's the only piece that can jump over others.", "Capture the black pawn with your knight."));
  L.push({ title: "Pawn captures", intro: "Pawns move straight ahead but capture diagonally — one square forward to the left or right. They can never move backward.",
    tasks: Array.from({ length: 5 }, () => captureTask("P", ["n", "b", "r", "p", "q"][Math.floor(rand() * 5)], "Capture the black piece with your pawn.")) });
  L.push({ title: "Promotion", intro: "When a pawn reaches the far side of the board it promotes — it becomes a queen, rook, bishop or knight (almost always a queen).",
    tasks: [0, 2, 3, 5, 7].map((i) => goalTask(`8/${i || ""}P${7 - i || ""}/8/8/k7/8/8/4K3 w - - 0 1`, { type: "promote" }, "Push your pawn to the last rank and promote it.")) });
  L.push({ title: "Castling", intro: "Castling moves your king two squares toward a rook, and the rook jumps to the other side of the king — in one move. You can't castle if the king or rook has moved, if pieces are in the way, or out of or through check.",
    tasks: [
      goalTask("r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1", { type: "castle", side: "k" }, "Castle kingside (short castling): click your king, then the square two to its right."),
      goalTask("r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1", { type: "castle", side: "q" }, "Castle queenside (long castling): click your king, then the square two to its left."),
      goalTask("rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", { type: "castle", side: "k" }, "A real opening position: castle kingside to get your king safe."),
      goalTask("r1bqkbnr/pp3ppp/2n1p3/2ppP3/3P4/2PB1N2/PP3PPP/RNBQK2R w KQkq - 0 1", { type: "castle", side: "k" }, "Castle kingside."),
      goalTask("r3kbnr/ppp2ppp/2nq4/3p1b2/3P4/2NBBN2/PPPQ1PPP/R3K2R w KQkq - 0 1", { type: "castle", side: "q" }, "Castle queenside to put your king on c1."),
    ] });
  L.push({ title: "En passant", intro: "If an enemy pawn moves two squares and lands right beside your pawn, you may capture it as if it had moved only one square. You must do it immediately, or the chance is gone.",
    tasks: ["d", "c", "f", "b", "g"].map((f) => {
      const i = "abcdefgh".indexOf(f);
      // Black pawn just arrived on the 5th rank right next to a white pawn
      const cells = Array(8).fill(null); cells[i] = "p"; cells[i + 1 <= 7 ? i + 1 : i - 1] = "P";
      let s = "", e = 0; for (const c of cells) { if (c) { if (e) s += e; e = 0; s += c; } else e++; } if (e) s += e;
      const wp = "abcdefgh"[i + 1 <= 7 ? i + 1 : i - 1];
      return goalTask(`4k3/8/8/${s}/8/8/8/4K3 w - ${f}6 0 1`, { type: "enpassant" }, `Black just played ${f}7–${f}5. Capture it en passant with your ${wp}-pawn.`);
    }) });
  L.push({ title: "Giving check", intro: "When a piece attacks the enemy king, that's check. The opponent must get out of check on their very next move.",
    tasks: ["Q", "R", "B", "N", "R"].map(giveCheckTask) });
  L.push({ title: "Getting out of check", intro: "There are three ways out of check: move the king to a safe square, block the attack with another piece, or capture the attacking piece. If none works, it's checkmate.",
    tasks: Array.from({ length: 5 }, escapeCheckTask) });
  L.push({ title: "Piece values", intro: "Pieces are worth different amounts: pawn 1, knight 3, bishop 3, rook 5, queen 9. When you can take something for free, take the most valuable piece.",
    tasks: Array.from({ length: 5 }, bestCaptureTask) });
  L.push(themeLesson("Your first checkmate", "mateIn1", [400, 700], "Checkmate means the king is attacked and can't escape — that wins the game."));
  L.push(themeLesson("Free pieces", "hangingPiece", [400, 700]));
  L.push(themeLesson("Checkmate in one" + levelName(2), "mateIn1", [600, 850]));
  L.push(themeLesson("Free pieces" + levelName(2), "hangingPiece", [650, 900]));
  L.push(themeLesson("Back-rank basics", "backRankMate", [500, 900], "", has("backRankMate", "mateIn1")));
  L.push(themeLesson("Your first fork", "fork", [400, 750]));
  L.push(themeLesson("Checkmate in one" + levelName(3), "mateIn1", [800, 1000]));
  L.push(themeLesson("Your first pin", "pin", [450, 800]));
  L.push(themeLesson("One good move", "oneMove", [500, 800]));
  L.push(themeLesson("Free pieces" + levelName(3), "hangingPiece", [850, 1050]));
  L.push(themeLesson("Promote your pawn", "promotion", [500, 850]));
  L.push(themeLesson("Forks" + levelName(2), "fork", [700, 950]));
  L.push(themeLesson("Attack f7", "attackingF2F7", [500, 900]));
  L.push(themeLesson("Opening traps", "opening", [450, 800]));
  L.push(themeLesson("Checkmate in one" + levelName(4), "mateIn1", [950, 1150]));
  L.push(themeLesson("Trapped pieces", "trappedPiece", [500, 950]));
  L.push(themeLesson("Pins" + levelName(2), "pin", [750, 1000]));
  L.push(themeLesson("Skewers", "skewer", [500, 900]));
  L.push(themeLesson("Easy endgames", "endgame", [450, 750], "", has("endgame", "short")));
  L.push(themeLesson("Pawn endgame basics", "pawnEndgame", [500, 900]));
  L.push(themeLesson("Discovered attacks", "discoveredAttack", [500, 900]));
  L.push(themeLesson("Checkmate in two", "mateIn2", [500, 850]));
  L.push(themeLesson("Capture the defender", "capturingDefender", [550, 1000]));
  L.push(themeLesson("Forks" + levelName(3), "fork", [900, 1100]));
  L.push(themeLesson("Find the win", "crushing", [500, 800], "", has("crushing", "short")));

  L.push(themeLesson("Checkmate in two" + levelName(2), "mateIn2", [800, 1050]));
  L.push(themeLesson("Beginner graduation", "short", [900, 1150], "Mixed puzzles: use everything you've learned."));
  return L;
}

function section2() {
  const L = [];
  const patterns = [
    ["Back-rank mate", "backRankMate", [600, 1000]], ["Back-rank mate" + levelName(2), "backRankMate", [1000, 1400]],
    ["Smothered mate", "smotheredMate", [800, 1300]], ["Smothered mate" + levelName(2), "smotheredMate", [1300, 1800]],
    ["Anastasia's mate", "anastasiaMate", [900, 1600]], ["Arabian mate", "arabianMate", [800, 1500]],
    ["Hook mate", "hookMate", [900, 1600]], ["Boden's mate", "bodenMate", [900, 1700]],
    ["Double-bishop mate", "doubleBishopMate", [900, 1700]], ["Dovetail mate", "dovetailMate", [900, 1600]],
    ["Corner mate", "cornerMate", [900, 1600]], ["Epaulette mate", "epauletteMate", [900, 1600]],
    ["Opera mate", "operaMate", [900, 1600]], ["Pillsbury's mate", "pillsburysMate", [1000, 1700]],
    ["Morphy's mate", "morphysMate", [1000, 1700]], ["Triangle mate", "triangleMate", [1000, 1700]],
    ["Swallow's tail mate", "swallowstailMate", [1000, 1700]], ["Kill box mate", "killBoxMate", [1000, 1700]],
    ["Blind swine mate", "blindSwineMate", [1100, 1800]], ["Vuković mate", "vukovicMate", [1100, 1900]],
    ["Balestra mate", "balestraMate", [1100, 2000]],
  ];
  for (const [t, th, r] of patterns) L.push(themeLesson(t, th, r));
  const ladder = [
    ["Mate in one", "mateIn1", [1100, 1300]], ["Mate in one" + levelName(2), "mateIn1", [1300, 1550]], ["Mate in one" + levelName(3), "mateIn1", [1550, 1850]],
    ["Mate in two", "mateIn2", [1050, 1250]], ["Mate in two" + levelName(2), "mateIn2", [1250, 1450]], ["Mate in two" + levelName(3), "mateIn2", [1450, 1650]],
    ["Mate in two" + levelName(4), "mateIn2", [1650, 1850]], ["Mate in two" + levelName(5), "mateIn2", [1850, 2100]],
    ["Mate in three", "mateIn3", [1100, 1400]], ["Mate in three" + levelName(2), "mateIn3", [1400, 1650]], ["Mate in three" + levelName(3), "mateIn3", [1650, 1900]],
    ["Mate in three" + levelName(4), "mateIn3", [1900, 2200]], ["Mate in four", "mateIn4", [1200, 1700]],
    ["Mate with a sacrifice", "sacrifice", [1200, 1600], "Give something up to force mate.", has("sacrifice", "mate")],
    ["Mate with double check", "doubleCheck", [1100, 1600], "", has("doubleCheck", "mate")],
    ["Mate with a discovered check", "discoveredCheck", [1100, 1600], "", has("discoveredCheck", "mate")],
    ["Mate on an exposed king", "exposedKing", [1100, 1600], "", has("exposedKing", "mate")],
    ["Mate on the f-file", "attackingF2F7", [1000, 1500], "", has("attackingF2F7", "mate")],
    ["Mating attacks", "kingsideAttack", [1300, 1800], "", has("kingsideAttack", "mate")],
  ];
  for (const [t, th, r, extra, filter] of ladder) L.push(themeLesson(t, th, r, extra || "", filter));
  return L;
}

function section3() {
  const L = [];
  const themes = ["fork", "pin", "skewer", "discoveredAttack", "discoveredCheck", "doubleCheck", "deflection", "attraction",
    "clearance", "interference", "xRayAttack", "trappedPiece", "hangingPiece", "capturingDefender", "sacrifice", "intermezzo",
    "quietMove", "defensiveMove", "zugzwang", "advancedPawn"];
  const names = { fork: "Forks", pin: "Pins", skewer: "Skewers", discoveredAttack: "Discovered attacks", discoveredCheck: "Discovered checks",
    doubleCheck: "Double checks", deflection: "Deflection", attraction: "Attraction", clearance: "Clearance", interference: "Interference",
    xRayAttack: "X-ray attacks", trappedPiece: "Trapping pieces", hangingPiece: "Spotting free pieces", capturingDefender: "Removing the defender",
    sacrifice: "Sacrifices", intermezzo: "In-between moves", quietMove: "Quiet moves", defensiveMove: "Only moves (defense)",
    zugzwang: "Zugzwang", advancedPawn: "Advanced pawns" };
  themes.forEach((th) => L.push(themeLesson(names[th], th, [1000, 1350])));
  themes.forEach((th) => L.push(themeLesson(names[th] + levelName(2), th, [1450, 1850])));
  return L;
}

const OPENINGS = [
  ["Italian_Game", "Italian Game", "e4 e5 Nf3 Nc6 Bc4", "w", "White develops quickly and aims the bishop at f7, Black's weakest square. One of the oldest openings — great for learning to attack."],
  ["Ruy_Lopez", "Ruy Lopez (Spanish)", "e4 e5 Nf3 Nc6 Bb5", "w", "White pressures the knight that defends e5. A deep, strategic opening played at every level, including world championships."],
  ["Scotch_Game", "Scotch Game", "e4 e5 Nf3 Nc6 d4", "w", "White strikes in the center right away with d4, opening lines for quick development."],
  ["Four_Knights_Game", "Four Knights Game", "e4 e5 Nf3 Nc6 Nc3 Nf6", "w", "Both sides bring out their knights first — simple, solid development."],
  ["Three_Knights_Opening", "Three Knights Opening", "e4 e5 Nf3 Nc6 Nc3 Bb4", "w", "Like the Four Knights, but Black skips ...Nf6 for a different setup."],
  ["Russian_Game", "Petrov's Defense", "e4 e5 Nf3 Nf6", "b", "Black counterattacks White's e4 pawn instead of defending e5. Very solid and symmetrical."],
  ["Philidor_Defense", "Philidor Defense", "e4 e5 Nf3 d6", "b", "Black defends e5 with a pawn. Solid but a bit passive — watch out for early traps."],
  ["Vienna_Game", "Vienna Game", "e4 e5 Nc3", "w", "White develops the queen's knight first, keeping the option of a quick f4."],
  ["Bishops_Opening", "Bishop's Opening", "e4 e5 Bc4", "w", "White puts the bishop on its best diagonal immediately, eyeing f7."],
  ["Kings_Gambit_Accepted", "King's Gambit Accepted", "e4 e5 f4 exf4", "w", "White sacrifices a pawn to open the f-file and grab the center. Wild, attacking chess."],
  ["Kings_Gambit_Declined", "King's Gambit Declined", "e4 e5 f4 Bc5", "w", "Black refuses the pawn and develops with tempo instead."],
  ["Center_Game", "Center Game", "e4 e5 d4 exd4 Qxd4", "w", "White recaptures with the queen early. Fast, but the queen can be chased around."],
  ["Danish_Gambit", "Danish Gambit", "e4 e5 d4 exd4 c3", "w", "White offers pawns for a big lead in development and open lines toward Black's king."],
  ["Ponziani_Opening", "Ponziani Opening", "e4 e5 Nf3 Nc6 c3", "w", "White prepares d4 with c3 to build a big pawn center."],
  ["Elephant_Gambit", "Elephant Gambit", "e4 e5 Nf3 d5", "b", "A risky counter-gambit: Black strikes the center at once."],
  ["Sicilian_Defense", "Sicilian Defense", "e4 c5", "b", "The most popular answer to 1.e4. Black fights for the center from the side and gets an unbalanced, fighting game."],
  ["French_Defense", "French Defense", "e4 e6 d4 d5", "b", "Black builds a solid pawn chain and counterattacks White's center later."],
  ["Caro-Kann_Defense", "Caro-Kann Defense", "e4 c6 d4 d5", "b", "Like the French, but Black's light-squared bishop stays free. Rock-solid."],
  ["Scandinavian_Defense", "Scandinavian Defense", "e4 d5", "b", "Black challenges e4 immediately. The queen often recaptures on d5 early."],
  ["Pirc_Defense", "Pirc Defense", "e4 d6 d4 Nf6 Nc3 g6", "b", "Black lets White build a center, then attacks it with pieces and a fianchettoed bishop."],
  ["Modern_Defense", "Modern Defense", "e4 g6", "b", "Black fianchettoes the bishop on g7 first and keeps the setup flexible."],
  ["Alekhine_Defense", "Alekhine's Defense", "e4 Nf6", "b", "Black provokes White's pawns forward, planning to attack them later."],
  ["Nimzowitsch_Defense", "Nimzowitsch Defense", "e4 Nc6", "b", "An offbeat knight move that pressures d4."],
  ["Owen_Defense", "Owen's Defense", "e4 b6", "b", "Black fianchettoes the queen's bishop to aim at e4."],
  ["Queens_Gambit_Declined", "Queen's Gambit Declined", "d4 d5 c4 e6", "b", "Black keeps a strong pawn on d5. One of the most solid defenses in chess."],
  ["Queens_Gambit_Accepted", "Queen's Gambit Accepted", "d4 d5 c4 dxc4", "b", "Black takes the pawn, then usually gives it back to develop freely."],
  ["Slav_Defense", "Slav Defense", "d4 d5 c4 c6", "b", "Black supports d5 with the c-pawn and keeps the bishop free."],
  ["Semi-Slav_Defense", "Semi-Slav Defense", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", "b", "A combination of Slav and Queen's Gambit Declined ideas — sharp and rich."],
  ["Kings_Indian_Defense", "King's Indian Defense", "d4 Nf6 c4 g6 Nc3 Bg7", "b", "Black lets White take the center, then strikes back — often with a kingside attack."],
  ["Nimzo-Indian_Defense", "Nimzo-Indian Defense", "d4 Nf6 c4 e6 Nc3 Bb4", "b", "Black pins the knight to stop e4. A favorite of world champions."],
  ["Grunfeld_Defense", "Grünfeld Defense", "d4 Nf6 c4 g6 Nc3 d5", "b", "Black allows a big white center, then attacks it with pieces."],
  ["Benoni_Defense", "Benoni Defense", "d4 Nf6 c4 c5 d5", "b", "Black creates an unbalanced pawn structure and plays for active piece play."],
  ["Dutch_Defense", "Dutch Defense", "d4 f5", "b", "Black grabs control of e4 with the f-pawn — aggressive, aiming for a kingside attack."],
  ["Englund_Gambit", "Englund Gambit", "d4 e5", "b", "A tricky pawn sacrifice full of traps — learn to punish it, or to use it."],
  ["Blackmar-Diemer_Gambit", "Blackmar–Diemer Gambit", "d4 d5 e4", "w", "White sacrifices a pawn for fast development and attacking chances."],
  ["Trompowsky_Attack", "Trompowsky Attack", "d4 Nf6 Bg5", "w", "White pins the knight right away and avoids main-line theory."],
  ["Queens_Pawn_Game", "Queen's Pawn Game & London", "d4 d5 Nf3 Nf6 Bf4", "w", "Simple, solid setups like the London System: develop and build a strong center."],
  ["English_Opening", "English Opening", "c4", "w", "White controls d5 from the side. Flexible and positional."],
  ["Zukertort_Opening", "Réti & Zukertort", "Nf3 d5 g3", "w", "White develops first and decides on a pawn structure later."],
  ["Bird_Opening", "Bird's Opening", "f4", "w", "White grabs e5 with the f-pawn — like a Dutch Defense with an extra move."],
];

function section4() {
  return OPENINGS.map(([tag, name, line, side, about], i) => {
    // First task: play the opening's moves yourself
    const g = new Chess();
    const uci = line.split(" ").map((san) => { const m = g.move(san); if (!m) throw new Error(`bad opening move ${san} in ${name}`); return m.from + m.to + (m.promotion || ""); });
    const playTask = { kind: "line", fen: new Chess().fen(), moves: uci, side, prompt: `Play the ${name}: ${line.split(" ").map((m, j) => (j % 2 === 0 ? `${j / 2 + 1}.${m}` : m)).join(" ")}. You play ${side === "w" ? "White" : "Black"}.` };
    const lo = 700 + Math.floor(i / 4) * 80;
    return { title: name, intro: `${about} Moves: ${line.split(" ").map((m, j) => (j % 2 === 0 ? `${j / 2 + 1}.${m}` : m)).join(" ")}. Then solve puzzles from real games in this opening.`,
      tasks: [playTask, ...pick(opening(tag), [lo, lo + 500], 4)] };
  });
}

function section5() {
  const L = [];
  const plan = [
    ["Kingside attack", "kingsideAttack", [1100, 1400]], ["Kingside attack" + levelName(2), "kingsideAttack", [1400, 1700]], ["Kingside attack" + levelName(3), "kingsideAttack", [1700, 2000]],
    ["Queenside play", "queensideAttack", [1100, 1500]], ["Queenside play" + levelName(2), "queensideAttack", [1500, 1900]],
    ["Attacking f7", "attackingF2F7", [1100, 1500]], ["Attacking f7" + levelName(2), "attackingF2F7", [1500, 1900]],
    ["Exposed kings", "exposedKing", [1100, 1450]], ["Exposed kings" + levelName(2), "exposedKing", [1450, 1800]], ["Exposed kings" + levelName(3), "exposedKing", [1800, 2100]],
    ["Winning sacrifices", "sacrifice", [1200, 1500], "", has("sacrifice", "middlegame")], ["Winning sacrifices" + levelName(2), "sacrifice", [1500, 1850], "", has("sacrifice", "middlegame")],
    ["Advanced pawns", "advancedPawn", [1100, 1450], "", has("advancedPawn", "middlegame")], ["Advanced pawns" + levelName(2), "advancedPawn", [1450, 1850], "", has("advancedPawn", "middlegame")],
    ["Defending", "defensiveMove", [1100, 1450], "", has("defensiveMove", "middlegame")], ["Defending" + levelName(2), "defensiveMove", [1450, 1850], "", has("defensiveMove", "middlegame")],
    ["Saving the game", "equality", [1200, 1700]], ["Saving the game" + levelName(2), "equality", [1700, 2200]],
    ["Quiet killers", "quietMove", [1200, 1600], "", has("quietMove", "middlegame")], ["Quiet killers" + levelName(2), "quietMove", [1600, 2000], "", has("quietMove", "middlegame")],
    ["Crushing blows", "crushing", [1100, 1350], "", has("crushing", "middlegame")], ["Crushing blows" + levelName(2), "crushing", [1350, 1600], "", has("crushing", "middlegame")],
    ["Crushing blows" + levelName(3), "crushing", [1600, 1850], "", has("crushing", "middlegame")], ["Crushing blows" + levelName(4), "crushing", [1850, 2100], "", has("crushing", "middlegame")],
    ["Getting the advantage", "advantage", [1100, 1400], "", has("advantage", "middlegame")], ["Getting the advantage" + levelName(2), "advantage", [1400, 1700], "", has("advantage", "middlegame")],
    ["Getting the advantage" + levelName(3), "advantage", [1700, 2000], "", has("advantage", "middlegame")],
    ["Middlegame forks", "fork", [1300, 1700], "", has("fork", "middlegame")], ["Middlegame pins", "pin", [1300, 1700], "", has("pin", "middlegame")],
    ["Breaking the defense", "capturingDefender", [1300, 1800], "", has("capturingDefender", "middlegame")],
    ["Deflect and win", "deflection", [1300, 1800], "", has("deflection", "middlegame")], ["Lure the king", "attraction", [1300, 1800], "", has("attraction", "middlegame")],
    ["Open the lines", "clearance", [1300, 1900], "", has("clearance", "middlegame")], ["Trapped pieces in the middlegame", "trappedPiece", [1300, 1900], "", has("trappedPiece", "middlegame")],
    ["Long attacks", "long", [1300, 1700], "", has("long", "middlegame", "kingsideAttack")], ["Long attacks" + levelName(2), "long", [1700, 2100], "", has("long", "middlegame", "kingsideAttack")],
    ["Discovered attacks in the middlegame", "discoveredAttack", [1300, 1800], "", has("discoveredAttack", "middlegame")],
    ["Middlegame tests", "middlegame", [1500, 1800]], ["Middlegame tests" + levelName(2), "middlegame", [1800, 2100]], ["Middlegame tests" + levelName(3), "middlegame", [2100, 2400]],
  ];
  for (const [t, th, r, extra, filter] of plan) L.push(themeLesson(t, th, r, extra || "", filter));
  return L;
}

function section6() {
  const L = [];
  const plan = [
    ["Pawn endgames", "pawnEndgame", [800, 1100]], ["Pawn endgames" + levelName(2), "pawnEndgame", [1100, 1400]], ["Pawn endgames" + levelName(3), "pawnEndgame", [1400, 1700]],
    ["Pawn endgames" + levelName(4), "pawnEndgame", [1700, 2000]], ["Pawn endgames" + levelName(5), "pawnEndgame", [2000, 2400]],
    ["Rook endgames", "rookEndgame", [900, 1150]], ["Rook endgames" + levelName(2), "rookEndgame", [1150, 1400]], ["Rook endgames" + levelName(3), "rookEndgame", [1400, 1650]],
    ["Rook endgames" + levelName(4), "rookEndgame", [1650, 1900]], ["Rook endgames" + levelName(5), "rookEndgame", [1900, 2200]], ["Rook endgames" + levelName(6), "rookEndgame", [2200, 2600]],
    ["Bishop endgames", "bishopEndgame", [900, 1300]], ["Bishop endgames" + levelName(2), "bishopEndgame", [1300, 1700]], ["Bishop endgames" + levelName(3), "bishopEndgame", [1700, 2200]],
    ["Knight endgames", "knightEndgame", [900, 1300]], ["Knight endgames" + levelName(2), "knightEndgame", [1300, 1700]], ["Knight endgames" + levelName(3), "knightEndgame", [1700, 2200]],
    ["Queen endgames", "queenEndgame", [900, 1300]], ["Queen endgames" + levelName(2), "queenEndgame", [1300, 1700]], ["Queen endgames" + levelName(3), "queenEndgame", [1700, 2200]],
    ["Queen and rook endgames", "queenRookEndgame", [1000, 1500]], ["Queen and rook endgames" + levelName(2), "queenRookEndgame", [1500, 2000]],
    ["Promote!", "promotion", [900, 1300], "", has("promotion", "endgame")], ["Promote!" + levelName(2), "promotion", [1300, 1700], "", has("promotion", "endgame")],
    ["Promote!" + levelName(3), "promotion", [1700, 2100], "", has("promotion", "endgame")],
    ["Under-promotion", "underPromotion", [1000, 2000]], ["Passed pawns", "advancedPawn", [1000, 1400], "", has("advancedPawn", "endgame")],
    ["Passed pawns" + levelName(2), "advancedPawn", [1400, 1900], "", has("advancedPawn", "endgame")],
    ["Zugzwang", "zugzwang", [1000, 1500], "", has("zugzwang", "endgame")], ["Zugzwang" + levelName(2), "zugzwang", [1500, 2100], "", has("zugzwang", "endgame")],
    ["Endgame tactics: forks", "fork", [1000, 1500], "", has("fork", "endgame")], ["Endgame tactics: skewers", "skewer", [1000, 1600], "", has("skewer", "endgame")],
    ["Endgame tactics: pins", "pin", [1000, 1600], "", has("pin", "endgame")], ["Hold the draw", "equality", [1200, 1800], "", has("equality", "endgame")],
    ["Hold the draw" + levelName(2), "equality", [1800, 2400], "", has("equality", "endgame")], ["Endgame defense", "defensiveMove", [1100, 1700], "", has("defensiveMove", "endgame")],
    ["Mate in the endgame", "mate", [1000, 1600], "", has("mate", "endgame")],
    ["Endgame tests", "endgame", [1500, 1900]], ["Endgame tests" + levelName(2), "endgame", [1900, 2300]], ["Endgame tests" + levelName(3), "endgame", [2300, 2700]],
  ];
  for (const [t, th, r, extra, filter] of plan) L.push(themeLesson(t, th, r, extra || "", filter));
  return L;
}

function section7() {
  const L = [];
  const plan = [
    ["Mate in four", "mateIn4", [1700, 2100]], ["Mate in four" + levelName(2), "mateIn4", [2100, 2500]],
    ["Mate in five+", "mateIn5", [1700, 2200]], ["Mate in five+" + levelName(2), "mateIn5", [2200, 2700]],
    ["Deep combinations", "veryLong", [1800, 2100]], ["Deep combinations" + levelName(2), "veryLong", [2100, 2400]], ["Deep combinations" + levelName(3), "veryLong", [2400, 2800]],
    ["From titled players' games", "master", [1800, 2100]], ["From titled players' games" + levelName(2), "master", [2100, 2400]], ["From titled players' games" + levelName(3), "master", [2400, 2800]],
    ["Master vs master", "masterVsMaster", [1800, 2200]], ["Master vs master" + levelName(2), "masterVsMaster", [2200, 2700]],
    ["Super grandmasters", "superGM", [1600, 2600]],
    ["Expert forks", "fork", [2000, 2400]], ["Expert pins", "pin", [2000, 2400]], ["Expert skewers", "skewer", [2000, 2500]],
    ["Expert discovered attacks", "discoveredAttack", [2000, 2400]], ["Expert deflection", "deflection", [2000, 2500]],
    ["Expert attraction", "attraction", [2000, 2500]], ["Expert clearance", "clearance", [2000, 2600]], ["Expert interference", "interference", [1900, 2600]],
    ["Expert quiet moves", "quietMove", [2000, 2500]], ["Expert in-between moves", "intermezzo", [1900, 2600]],
    ["Expert sacrifices", "sacrifice", [2000, 2400]], ["Expert sacrifices" + levelName(2), "sacrifice", [2400, 2800]],
    ["Expert defense", "defensiveMove", [2000, 2500]], ["Expert zugzwang", "zugzwang", [2000, 2600]],
    ["Expert endgames", "endgame", [2400, 2800], "", has("endgame", "long")], ["Expert rook endgames", "rookEndgame", [2300, 2800]],
    ["Expert pawn endgames", "pawnEndgame", [2300, 2800]], ["Expert mate in two", "mateIn2", [2100, 2500]], ["Expert mate in three", "mateIn3", [2200, 2600]],
    ["Expert kingside attacks", "kingsideAttack", [2100, 2500]], ["Expert exposed kings", "exposedKing", [2100, 2600]],
    ["Grandmaster level", "crushing", [2400, 2600], "", has("crushing", "long")], ["Grandmaster level" + levelName(2), "crushing", [2600, 2800], "", has("crushing", "long")],
    ["Grandmaster level" + levelName(3), "advantage", [2500, 2900], "", has("advantage", "long")],
    ["Grandmaster level" + levelName(4), "crushing", [2800, 3100]],
    ["The final exam", "veryLong", [2600, 3200], "The hardest puzzles in the course. Take your time."],
    ["Champion", "long", [2900, 3300], "If you solve these, you're playing like a champion."],
  ];
  for (const [t, th, r, extra, filter] of plan) L.push(themeLesson(t, th, r, extra || "", filter));
  return L;
}

const SECTIONS = [
  { id: 1, title: "Chess Basics", icon: "♙", about: "How every piece moves, castling, en passant, check and checkmate — then your first puzzles.", build: section1 },
  { id: 2, title: "Checkmate Patterns", icon: "♚", about: "The classic mating patterns every player should know, plus mate in 1, 2 and 3.", build: section2 },
  { id: 3, title: "Tactics", icon: "⚔", about: "Forks, pins, skewers, discovered attacks and every other tactic — in two levels each.", build: section3 },
  { id: 4, title: "Openings", icon: "♘", about: "Forty real openings. Play the moves yourself, then solve puzzles from games in that opening.", build: section4 },
  { id: 5, title: "Middlegame & Attack", icon: "♛", about: "Attacking the king, sacrifices, defending, and turning an edge into a win.", build: section5 },
  { id: 6, title: "Endgames", icon: "♔", about: "Pawn, rook, bishop, knight and queen endgames, promotion and zugzwang.", build: section6 },
  { id: 7, title: "Master Class", icon: "♕", about: "Long combinations and puzzles from master games, up to grandmaster level.", build: section7 },
];

(async () => {
  if (!fs.existsSync(CACHE)) await download();
  POOL = loadPuzzles();
  console.log(`${POOL.length} puzzles loaded`);
  fs.mkdirSync(OUT, { recursive: true });
  const index = [];
  for (const s of SECTIONS) {
    const lessons = s.build();
    if (lessons.length !== 40) throw new Error(`Section ${s.id} has ${lessons.length} lessons`);
    lessons.forEach((l, i) => (l.id = `${s.id}-${i + 1}`));
    fs.writeFileSync(path.join(OUT, `section-${s.id}.json`), JSON.stringify({ id: s.id, title: s.title, lessons }));
    index.push({ id: s.id, title: s.title, icon: s.icon, about: s.about, lessons: lessons.map((l) => ({ id: l.id, title: l.title, tasks: l.tasks.length })) });
    console.log(`Section ${s.id} ${s.title}: ${lessons.length} lessons, ${lessons.reduce((n, l) => n + l.tasks.length, 0)} tasks`);
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ sections: index, credit: "Puzzles from the Lichess puzzle database (CC0)" }, null, 1));
  console.log(`Done: ${used.size} database puzzles used.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
