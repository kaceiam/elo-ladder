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

// orientation: "w" or "b" (the color at the bottom); selected: square or null
function boardHtml(game, orientation, selected) {
  const files = "abcdefgh";
  const ranks = orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const cols = orientation === "w" ? [...files] : [...files].reverse();
  const hist = game.history({ verbose: true });
  const last = hist[hist.length - 1];
  const targets = selected ? game.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
  const names = squareNamesOn();
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
      (p ? `<span class="pc ${p.color}">${GLYPH[p.type]}</span>` : "") +
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
  return `<button type="button" data-toggle-names>${squareNamesOn() ? "🔤 Hide square names" : "🔤 Show square names"}</button>
    <button type="button" data-notation-help>❓ How to read e4, Nf3…</button>`;
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
