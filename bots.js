// Chess bots: Stockfish 18 picks the moves at a set strength, and an Ollama
// model gives each bot a personality and reacts to the game.
// Needs chess.js (global `Chess`).
//
// Strength: from 1320 up, Stockfish's own UCI_Elo limiter is calibrated, so
// those bots use it directly. Below that Stockfish has no setting, so weaker
// bots run it at Skill Level 0 with a shallow search plus a chance of playing
// a random move each turn — those ratings are approximate.

const OLLAMA_URL = "http://127.0.0.1:11434";
const SF_VERSION = "18.0.8";
const SF_FILE = "stockfish-18-lite-single";

const BOTS = [
  { id: "pebble",   name: "Pebble",   elo: 400,  skill: 0, depth: 1, random: 0.4,
    persona: "an excitable kid who just learned how the pieces move and loves shouting about horses" },
  { id: "rusty",    name: "Rusty",    elo: 800,  skill: 0, depth: 1, random: 0.22,
    persona: "a retired mechanic who plays at the park and talks about engines and old trucks" },
  { id: "maple",    name: "Maple",    elo: 1200, skill: 0, depth: 8, random: 0.03,
    persona: "a cheerful club player who is polite, encouraging and a little nervous" },
  { id: "vex",      name: "Vex",      elo: 1600, limit: 1600, movetime: 800,
    persona: "a cocky online blitz player who trash-talks and uses gamer slang" },
  { id: "ironclad", name: "Ironclad", elo: 2000, limit: 2000, movetime: 1000,
    persona: "a stern military strategist who speaks in short, clipped orders" },
  { id: "sable",    name: "Sable",    elo: 2400, limit: 2400, movetime: 1200,
    persona: "a calm, mysterious chess master who speaks in quiet riddles" },
  { id: "oracle",   name: "Oracle",   elo: 2800, limit: 2800, movetime: 1500,
    persona: "an ancient all-knowing chess machine that is coldly confident it has already won" },
];

// ---------- Stockfish ----------

// Served over http (or inside the iPhone app) it loads the local copy. Opened
// as a file, browsers block local workers, so it loads the same build from a CDN.
function makeWorker() {
  if (location.protocol.startsWith("http") || location.protocol === "capacitor:") {
    return new Worker(new URL(`vendor/stockfish/${SF_FILE}.js`, location.href));
  }
  const base = `https://unpkg.com/stockfish@${SF_VERSION}/bin/${SF_FILE}`;
  const blob = new Blob([`importScripts("${base}.js");`], { type: "text/javascript" });
  return new Worker(`${URL.createObjectURL(blob)}#${encodeURIComponent(base + ".wasm")}`);
}

class Engine {
  constructor() {
    this.worker = makeWorker();
    this.waiters = [];
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      this.waiters = this.waiters.filter((w) => !w(line));
    };
    this.worker.onerror = (e) => console.error("Stockfish worker error", e);
    this.queue = this.request("uci", (l) => l === "uciok");
  }

  // Send commands, resolve with the first line `done` accepts
  request(cmds, done, onLine) {
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        if (onLine) onLine(line);
        if (!done(line)) return false;
        resolve(line);
        return true;
      });
      for (const c of [].concat(cmds)) this.worker.postMessage(c);
    });
  }

  // One search at a time; resolves with { uci, score } where score is in
  // centipawns for the side to move (mates are ±100000)
  think(fen, bot) {
    const run = async () => {
      const opts = bot.limit
        ? ["setoption name UCI_LimitStrength value true", `setoption name UCI_Elo value ${bot.limit}`]
        : ["setoption name UCI_LimitStrength value false", `setoption name Skill Level value ${bot.skill}`];
      await this.request([...opts, "isready"], (l) => l === "readyok");
      let score = 0;
      const go = bot.limit ? `go movetime ${bot.movetime}` : `go depth ${bot.depth}`;
      const line = await this.request([`position fen ${fen}`, go], (l) => l.startsWith("bestmove"), (l) => {
        const m = l.match(/score (cp|mate) (-?\d+)/);
        if (m) score = m[1] === "cp" ? +m[2] : Math.sign(+m[2]) * 100000;
      });
      return { uci: line.split(" ")[1], score };
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }
}

let engine = null;
const getEngine = () => (engine ||= new Engine());

// Returns { move: {from, to, promotion}, score }
async function botMove(bot, game) {
  const started = Date.now();
  let result;
  if (bot.random && Math.random() < bot.random) {
    const moves = game.moves({ verbose: true });
    const m = moves[Math.floor(Math.random() * moves.length)];
    result = { move: { from: m.from, to: m.to, promotion: m.promotion }, score: null };
  } else {
    const { uci, score } = await getEngine().think(game.fen(), bot);
    result = { move: { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, score };
  }
  // Instant replies feel robotic — give weak bots a beat to "think"
  const wait = 600 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return result;
}

// ---------- Ollama ----------

async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).models.map((m) => m.name);
}

function describeScore(score) {
  if (score === null) return "You just made a careless, impulsive move.";
  if (score >= 100000) return "You can see a forced checkmate coming for you.";
  if (score <= -100000) return "You are about to be checkmated.";
  const pawns = score / 100;
  if (pawns > 3) return "You are completely winning.";
  if (pawns > 1) return "You are clearly better.";
  if (pawns > -1) return "The game is roughly even.";
  if (pawns > -3) return "You are worse and under pressure.";
  return "You are badly losing.";
}

// One in-character line reacting to the last two moves
async function botComment(bot, model, game, score) {
  const hist = game.history();
  const mine = hist[hist.length - 1];
  const theirs = hist[hist.length - 2];
  const prompt =
    (theirs ? `Your opponent just played ${theirs}. ` : "") +
    `You replied ${mine}. ${describeScore(score)}` +
    (game.in_check() ? " Your move gives check." : "") +
    `\nSay one short line to your opponent, in character. No quotes, no move notation lists.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.9, num_predict: 50 },
        messages: [
          { role: "system", content: `You are ${bot.name}, ${bot.persona}. You are playing chess, rated ${bot.elo}. Reply with a single sentence under 20 words.` },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const text = (await res.json()).message.content.trim().split("\n")[0];
    return text.replace(/^["']|["']$/g, "").slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
}

// Opening line when a game starts
async function botGreeting(bot, model, botColor) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.9, num_predict: 50 },
      messages: [
        { role: "system", content: `You are ${bot.name}, ${bot.persona}. You are playing chess, rated ${bot.elo}. Reply with a single sentence under 20 words.` },
        { role: "user", content: `A new game is starting and you are playing ${botColor === "w" ? "White" : "Black"}. Greet your opponent in character.` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).message.content.trim().split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 200);
}
