// Chess.com-style Elo rating system — JS port of elo.py

const MIN_ELO = 0;
const MAX_ELO = 30000;

// [minimum elo, rank name], highest first — add tiers here
const RANKS = [
  [2500, "Grandmaster"],
  [2000, "Master"],
  [1500, "Advanced"],
  [1000, "Intermediate"],
  [0, "Beginner"],
];

// New players move fast, established and top players move slower
const PROVISIONAL_GAMES = 30;
const K_PROVISIONAL = 40;
const K_ESTABLISHED = 20;
const K_TOP = 10;
const TOP_ELO = 2400;

function rankOf(elo) {
  for (const [threshold, name] of RANKS) if (elo >= threshold) return name;
  return RANKS[RANKS.length - 1][1];
}

function kFactor(player) {
  if (player.games < PROVISIONAL_GAMES) return K_PROVISIONAL;
  if (player.elo >= TOP_ELO) return K_TOP;
  return K_ESTABLISHED;
}

function expectedScore(playerElo, opponentElo) {
  return 1 / (1 + 10 ** ((opponentElo - playerElo) / 400));
}

// result is from a's point of view: 1 = A wins, 0.5 = draw, 0 = A loses.
// Mutates both players and returns [changeA, changeB].
function recordMatch(a, b, result) {
  if (![0, 0.5, 1].includes(result)) throw new Error("result must be 1, 0.5 or 0");

  // Use pre-match ratings for both sides
  const expA = expectedScore(a.elo, b.elo);
  const changeA = kFactor(a) * (result - expA);
  const changeB = kFactor(b) * ((1 - result) - (1 - expA));

  for (const [p, change] of [[a, changeA], [b, changeB]]) {
    p.elo = Math.max(MIN_ELO, Math.min(p.elo + change, MAX_ELO));
    p.games += 1;
  }
  return [changeA, changeB];
}

if (typeof module !== "undefined") module.exports = { rankOf, kFactor, expectedScore, recordMatch };
