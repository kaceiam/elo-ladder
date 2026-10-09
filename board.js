// Board + move list rendering shared by every page with a board.
// Needs chess.js. Squares carry data-sq so pages can handle clicks.
//
// Square names: every square can show its name (a1…h8) so new players learn
// where "e4" is. Players toggle it with a button made by squareNamesButton();
// pages re-draw on the "squarenames" event. Anything with data-sq-ref="e4"
// (move lists, lesson text) lights up that square on the board when hovered.

// U+FE0E asks for the plain text symbol. Without it phones draw ♟ as a
// color emoji that's always black and ignores the piece color.
const GLYPH = { k: "♚︎", q: "♛︎", r: "♜︎", b: "♝︎", n: "♞︎", p: "♟︎" };

const NAMES_KEY = "elo-square-names";
function squareNamesOn() {
  try { return localStorage.getItem(NAMES_KEY) !== "off"; } catch { return true; }
}

// ---------- board themes ----------

// wins: games you must win to unlock; trophy: or win a Sunday Cup
const BOARD_THEMES = {
  wood: { name: "Classic wood", light: "#f0d9b5", dark: "#b58863", frame: "#6b4423", glow: "rgba(255, 210, 120, .35)", wins: 0 },
  emerald: { name: "Tournament green", light: "#eeeed2", dark: "#769656", frame: "#3e5c2c", glow: "rgba(190, 230, 120, .35)", wins: 0 },
  ocean: { name: "Ocean", light: "#e3edf3", dark: "#5f8fb0", frame: "#1f4560", glow: "rgba(120, 200, 255, .4)", wins: 1 },
  marble: { name: "Marble", light: "#ececec", dark: "#9c9fa6", frame: "#3c3f45", glow: "rgba(255, 255, 255, .35)", wins: 3 },
  midnight: { name: "Midnight", light: "#b8b6d9", dark: "#5a5891", frame: "#22204a", glow: "rgba(170, 150, 255, .45)", wins: 5 },
  sunset: { name: "Sunset", light: "#ffe2b8", dark: "#e07a4f", frame: "#7a2e1c", glow: "rgba(255, 160, 90, .45)", wins: 10 },
  candy: { name: "Candy", light: "#ffe6f0", dark: "#ee8fb5", frame: "#9c3d68", glow: "rgba(255, 150, 200, .45)", wins: 15 },
  neon: { name: "Neon", light: "#1c2c44", dark: "#0b1424", frame: "#00e5ff", glow: "rgba(0, 229, 255, .6)", wins: 25, glowPieces: ["#7ff6ff", "#ff4fb3"] },
  galaxy: { name: "Galaxy", light: "#3d3270", dark: "#191238", frame: "#a98bff", glow: "rgba(169, 139, 255, .7)", wins: 50, glowPieces: ["#ffffff", "#ffcf5c"] },
  gold: { name: "Champion gold", light: "#fff3c4", dark: "#d4a62a", frame: "#8a6510", glow: "rgba(255, 200, 60, .65)", wins: 100, trophy: true },
};
const THEME_KEY = "elo-board-theme";

// ---------- wins, trophies and unlocks (all saved in this browser) ----------

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
// Wins from every mode: bots, Play a Friend, Ranked and the Sunday Cup
function playerStats() {
  const bots = readJson("elo-ladder-v1", {});
  const friend = readJson("elo-friend-profile", {});
  const ranked = readJson("elo-ranked", {});
  const cup = readJson("elo-sunday-cup", {});
  const winsIn = (list) => (list || []).filter((g) => g.result === 1).length;
  const cupGames = Object.values(cup.weeks || {}).flatMap((w) => (w.rounds || []).map((r) => ({ result: r.myScore })));
  const trophies = Object.values(cup.weeks || {}).filter((w) => w.finished).map((w) => ({ week: w.week, place: w.place, score: w.myPoints }));
  return {
    wins: winsIn(bots.games) + winsIn(friend.history) + winsIn(ranked.history) + winsIn(cupGames),
    botWins: winsIn(bots.games), friendWins: winsIn(friend.history), rankedWins: winsIn(ranked.history), cupWins: winsIn(cupGames),
    trophies, champion: trophies.some((t) => t.place === 1),
  };
}
function themeUnlocked(id, stats = playerStats()) {
  const t = BOARD_THEMES[id];
  return !!t && (stats.wins >= t.wins || (t.trophy && stats.champion));
}
function boardTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return BOARD_THEMES[t] && themeUnlocked(t) ? t : "wood";
  } catch { return "wood"; }
}

// Pop up "New board unlocked!" for anything earned since last time
function checkUnlocks() {
  if (typeof document === "undefined") return;
  const stats = playerStats();
  const seen = readJson("elo-unlocks-seen", null);
  const unlocked = Object.keys(BOARD_THEMES).filter((id) => themeUnlocked(id, stats));
  try { localStorage.setItem("elo-unlocks-seen", JSON.stringify(unlocked)); } catch {}
  if (!seen) return; // first visit: nothing to celebrate yet
  const fresh = unlocked.filter((id) => !seen.includes(id));
  fresh.forEach((id, i) => setTimeout(() => toast(`🎉 New board unlocked: <b>${BOARD_THEMES[id].name}</b>`, "Use it", showThemePicker), i * 1200));
}
function toast(html, actionLabel, action) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${html}</span>${actionLabel ? `<button type="button" class="primary">${actionLabel}</button>` : ""}`;
  if (actionLabel) t.querySelector("button").addEventListener("click", () => { t.remove(); action(); });
  document.body.append(t);
  setTimeout(() => t.classList.add("out"), 6000);
  setTimeout(() => t.remove(), 6600);
}
function applyBoardTheme(id = boardTheme()) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.boardTheme = id;
}
// One CSS rule per theme, so switching is instant
if (typeof document !== "undefined") {
  const css = Object.entries(BOARD_THEMES).map(([id, t]) => {
    const glow = t.glowPieces ? ` --pc-b: ${t.glowPieces[1]}; --pc-b-glow: 0 0 6px ${t.glowPieces[1]}, 0 0 14px ${t.glowPieces[1]}; --pc-w-glow: 0 0 6px ${t.glowPieces[0]}, 0 0 14px ${t.glowPieces[0]};` : "";
    return `:root[data-board-theme="${id}"], [data-board-theme-preview="${id}"] { --light: ${t.light}; --dark: ${t.dark}; --frame: ${t.frame}; --board-glow: ${t.glow};${glow} }`;
  }).join("\n");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  applyBoardTheme();
}

// The last move slides into place, once per position. Pages often re-draw
// right after a move, so a re-draw continues the slide instead of restarting it.
const SLIDE_MS = 240;
let slideState = null;
const screenPos = (sq, orientation) => {
  const f = "abcdefgh".indexOf(sq[0]), r = +sq[1];
  return orientation === "w" ? [f, 8 - r] : [7 - f, r - 1];
};

// orientation: "w" or "b" (the color at the bottom); selected: square or null
// opts.names overrides the square-names setting (e.g. a decorative board)
function boardHtml(game, orientation, selected, opts = {}) {
  const files = "abcdefgh";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const cols = orientation === "w" ? [...files] : [...files].reverse();
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const targets = selected ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  const names = opts.names ?? squareNamesOn();
  let slide = null;
  if (last) {
    const fen = game.fen();
    if (!slideState || slideState.fen !== fen) {
      const [fx, fy] = screenPos(last.from, orientation), [tx, ty] = screenPos(last.to, orientation);
      slideState = { fen, sq: last.to, dx: fx - tx, dy: fy - ty, at: performance.now() };
    }
    const elapsed = performance.now() - slideState.at;
    if (elapsed < SLIDE_MS) slide = { ...slideState, delay: -Math.round(elapsed) };
  }
  let checkSq = null;
  if (game.in_check()) {
    for (const r of ranks) for (const f of cols) {
      const p = game.get(f + r);
      if (p && p.type === "k" && p.color === game.turn()) checkSq = f + r;
    }
  }

  let html = "";
  ranks.forEach((r, ri) => cols.forEach((f, fi) => {
    const sq = f + r;
    const p = game.get(sq);
    const cls = ["sq", (files.indexOf(f) + r) % 2 ? "d" : "l"];
    if (last && (last.from === sq || last.to === sq)) cls.push("last");
    if (sq === selected) cls.push("sel");
    if (targets.includes(sq)) cls.push("target");
    if (sq === checkSq) cls.push("check");
    html += `<div class="${cls.join(" ")}" data-sq="${sq}" title="${sq}">` +
      (names ? `<span class="sqname">${sq}</span>` : "") +
      (p ? (slide && slide.sq === sq
        ? `<span class="pc ${p.color} slide" style="--dx: ${slide.dx}; --dy: ${slide.dy}; animation-delay: ${slide.delay}ms">${GLYPH[p.type]}</span>`
        : `<span class="pc ${p.color}">${GLYPH[p.type]}</span>`) : "") +
      // Edge letters/numbers only when square names are off (they'd overlap)
      (!names && ri === 7 ? `<span class="coord f">${f}</span>` : "") +
      (!names && fi === 0 ? `<span class="coord r">${r}</span>` : "") + `</div>`;
  }));
  return html;
}

// Move list; hovering a move lights up the square it went to
function movesHtml(game) {
  const moves = game.history({ verbose: true });
  const cell = (m) => (m ? `<span class="mv" data-sq-ref="${m.from} ${m.to}" title="${m.from} → ${m.to}">${m.san}</span>` : "<span></span>");
  let html = "";
  for (let i = 0; i < moves.length; i += 2) {
    html += `<span class="dim">${i / 2 + 1}.</span>${cell(moves[i])}${cell(moves[i + 1])}`;
  }
  return html || `<span class="dim" style="grid-column: 1 / -1">No moves yet.</span>`;
}

// Click-to-move: first click picks one of `color`'s pieces, second click
// moves it. Calls onMove({from, to, promotion}) for legal moves (always
// promotes to a queen) and onSelect(square|null) whenever selection changes.
function handleBoardClick(e, game, color, selected, onMove, onSelect) {
  const cell = e.target.closest("[data-sq]");
  if (!cell) return;
  const sq = cell.dataset.sq;
  if (selected && game.moves({ square: selected, verbose: true }).some((m) => m.to === sq)) {
    onSelect(null);
    onMove({ from: selected, to: sq, promotion: "q" });
    return;
  }
  const piece = game.get(sq);
  onSelect(piece && piece.color === color && sq !== selected ? sq : null);
}

// ---------- square names toggle + notation help ----------

function squareNamesButton() {
  return `<button type="button" data-board-themes>🎨 Board style</button>
    <button type="button" data-toggle-names>${squareNamesOn() ? "🔤 Hide square names" : "🔤 Show square names"}</button>
    <button type="button" data-notation-help>❓ How to read e4, Nf3…</button>`;
}

// Theme picker: a mini board for every theme
function showThemePicker() {
  const current = boardTheme();
  const stats = playerStats();
  const mini = (id) => {
    let cells = "";
    for (let i = 0; i < 16; i++) cells += `<i class="${(Math.floor(i / 4) + i) % 2 ? "d" : "l"}"></i>`;
    return `<span class="mini" data-board-theme-preview="${id}">${cells}<b class="pc w">♞︎</b></span>`;
  };
  const box = document.createElement("div");
  box.className = "update-modal";
  box.innerHTML = `
    <div class="update-card" role="dialog" aria-label="Board style" style="max-width: 560px">
      <h2 style="margin: 0 0 4px">🎨 Pick a board style</h2>
      <p class="dim" style="margin: 0 0 12px">You've won <b>${stats.wins}</b> game${stats.wins === 1 ? "" : "s"}. Win more to unlock new boards!</p>
      <div class="theme-grid">${Object.entries(BOARD_THEMES).map(([id, t]) => {
        const open = themeUnlocked(id, stats);
        const need = t.trophy ? `Win a Sunday Cup or ${t.wins} games` : `Win ${t.wins} game${t.wins === 1 ? "" : "s"}`;
        return `<button type="button" class="theme-pick ${id === current ? "on" : ""} ${open ? "" : "locked"}" ${open ? `data-pick-theme="${id}"` : "disabled"}>
          ${mini(id)}<span>${t.name}</span>${open ? "" : `<small>🔒 ${need}<br>${Math.min(stats.wins, t.wins)} / ${t.wins}</small>`}</button>`;
      }).join("")}
      </div>
      <button class="primary" type="button" data-close style="margin-top: 14px">Done</button>
    </div>`;
  box.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick-theme]");
    if (pick) {
      try { localStorage.setItem(THEME_KEY, pick.dataset.pickTheme); } catch {}
      applyBoardTheme(pick.dataset.pickTheme);
      for (const b of box.querySelectorAll(".theme-pick")) b.classList.toggle("on", b === pick);
      return;
    }
    if (e.target === box || e.target.closest("[data-close]")) box.remove();
  });
  document.body.append(box);
}

// "Set your rating" box (bot and friend ratings live in your own browser)
function showRatingPicker(current, onPick) {
  const presets = [[600, "Just starting"], [1000, "Casual player"], [1400, "Club player"], [1800, "Strong player"], [2200, "Expert"]];
  const box = document.createElement("div");
  box.className = "update-modal";
  box.innerHTML = `
    <div class="update-card" role="dialog" aria-label="Set your rating">
      <h2 style="margin: 0 0 6px">Set your rating</h2>
      <p class="dim" style="margin: 0 0 12px">Pick how strong you are, or type an exact number (100–3000). Your rating keeps changing as you win and lose.</p>
      <div class="list">${presets.map(([elo, label]) => `
        <button type="button" class="seek pick" data-elo="${elo}"><span><b>${elo}</b> · ${label}</span><span class="rank ${rankOf(elo)}">${rankOf(elo)}</span></button>`).join("")}
      </div>
      <form class="row" style="margin-top: 12px">
        <input type="number" min="100" max="3000" step="1" value="${Math.round(current)}" aria-label="Exact rating">
        <button class="primary">Set</button>
        <button type="button" data-close>Cancel</button>
      </form>
    </div>`;
  const done = (elo) => {
    const v = Math.round(+elo);
    if (!(v >= 100 && v <= 3000)) return;
    onPick(v);
    box.remove();
  };
  box.addEventListener("click", (e) => {
    const p = e.target.closest("[data-elo]");
    if (p) return done(p.dataset.elo);
    if (e.target === box || e.target.closest("[data-close]")) box.remove();
  });
  box.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); done(box.querySelector("input").value); });
  document.body.append(box);
}

// Wrap square names (e4, f7…) in text so hovering them lights up the board
function linkSquares(text) {
  return String(text)
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    // A square on its own (e4) or inside a move (Nf3, exd5, Qxh7): link the whole word to its square
    .replace(/(?<![A-Za-z0-9])((?:[KQRBN])?(?:[a-h]?x)?)([a-h][1-8])(?![A-Za-z0-9])/g, `<span class="sqref" data-sq-ref="$2">$1$2</span>`);
}

function showNotationHelp() {
  const box = document.createElement("div");
  box.className = "update-modal";
  box.innerHTML = `
    <div class="update-card notation" role="dialog" aria-label="How chess notation works">
      <h2 style="margin: 0 0 8px">How to read chess notation</h2>
      <p><b>Every square has a name.</b> The columns are lettered <b>a</b> to <b>h</b> from left to right (from White's side),
        and the rows are numbered <b>1</b> to <b>8</b> from White's side to Black's. So <b>e4</b> is column e, row 4 —
        the square just in front of White's king pawn after it moves two steps.</p>
      <p>Turn on <b>🔤 square names</b> to see every square's name on the board, or hover a square to see it.</p>
      <table class="notation-table">
        <tr><td><b>K</b> Q R B N</td><td>King, Queen, Rook, Bishop, kNight (N, because K is the king). Pawns get no letter.</td></tr>
        <tr><td><b>e4</b></td><td>A pawn moves to e4.</td></tr>
        <tr><td><b>Nf3</b></td><td>A knight moves to f3.</td></tr>
        <tr><td><b>Bxc6</b></td><td><b>x</b> means a capture: the bishop takes the piece on c6.</td></tr>
        <tr><td><b>exd5</b></td><td>The pawn on the e-column captures on d5.</td></tr>
        <tr><td><b>Qh5+</b></td><td><b>+</b> means check.</td></tr>
        <tr><td><b>Qxf7#</b></td><td><b>#</b> means checkmate.</td></tr>
        <tr><td><b>O-O</b> / <b>O-O-O</b></td><td>Castling kingside (short) / queenside (long).</td></tr>
        <tr><td><b>e8=Q</b></td><td>A pawn reaches e8 and promotes to a queen.</td></tr>
        <tr><td><b>1. e4 e5</b></td><td>Move 1: White plays e4, Black answers e5.</td></tr>
        <tr><td><b>Nbd2</b></td><td>When two knights could go to d2, the extra letter says which one (the one on the b-column).</td></tr>
      </table>
      <button class="primary" type="button" style="margin-top: 12px">Got it</button>
    </div>`;
  box.addEventListener("click", (e) => { if (e.target === box || e.target.tagName === "BUTTON") box.remove(); });
  document.body.append(box);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-notation-help]")) return showNotationHelp();
    if (e.target.closest("[data-board-themes]")) return showThemePicker();
    const t = e.target.closest("[data-toggle-names]");
    if (!t) return;
    const on = !squareNamesOn();
    try { localStorage.setItem(NAMES_KEY, on ? "on" : "off"); } catch {}
    for (const b of document.querySelectorAll("[data-toggle-names]")) b.textContent = on ? "🔤 Hide square names" : "🔤 Show square names";
    document.dispatchEvent(new Event("squarenames"));
  });
  // Hover (or tap) a square name or a move to light it up on the board
  const ping = (refs, on) => {
    for (const sq of refs.split(" ")) for (const el of document.querySelectorAll(`[data-sq="${sq}"]`)) el.classList.toggle("ping", on);
  };
  document.addEventListener("mouseover", (e) => { const r = e.target.closest("[data-sq-ref]"); if (r) ping(r.dataset.sqRef, true); });
  document.addEventListener("mouseout", (e) => { const r = e.target.closest("[data-sq-ref]"); if (r) ping(r.dataset.sqRef, false); });
  document.addEventListener("click", (e) => {
    const r = e.target.closest("[data-sq-ref]");
    if (!r) return;
    ping(r.dataset.sqRef, true);
    setTimeout(() => ping(r.dataset.sqRef, false), 1200);
  });
}
