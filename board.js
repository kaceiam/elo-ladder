// Board + move list rendering shared by the bot page and the online page.
// Needs chess.js. Squares carry data-sq so pages can handle clicks.

// U+FE0E asks for the plain text symbol. Without it phones draw ♟ as a
// color emoji that's always black and ignores the piece color.
const GLYPH = { k: "♚︎", q: "♛︎", r: "♜︎", b: "♝︎", n: "♞︎", p: "♟︎" };

// orientation: "w" or "b" (the color at the bottom); selected: square or null
function boardHtml(game, orientation, selected) {
  const files = "abcdefgh";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const cols = orientation === "w" ? [...files] : [...files].reverse();
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const targets = selected ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
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
    html += `<div class="${cls.join(" ")}" data-sq="${sq}">` +
      (p ? `<span class="pc ${p.color}">${GLYPH[p.type]}</span>` : "") +
      (ri === 7 ? `<span class="coord f">${f}</span>` : "") +
      (fi === 0 ? `<span class="coord r">${r}</span>` : "") + `</div>`;
  }));
  return html;
}

function movesHtml(game) {
  const sans = game.history();
  let html = "";
  for (let i = 0; i < sans.length; i += 2) {
    html += `<span class="dim">${i / 2 + 1}.</span><span>${sans[i]}</span><span>${sans[i + 1] || ""}</span>`;
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
