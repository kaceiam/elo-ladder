// One timed game against a Stockfish opponent at any rating — used by Ranked
// and the Sunday Cup. Needs chess.js, elo.js, board.js and bots.js.
//
//   startMatch(rootEl, { me: {name, elo}, opp: {name, elo}, color: "w"|"b"|"random",
//                        clock: {base, inc} (ms), label, onEnd({ score, reason, color }) })
//
// score is 1 (win), 0.5 (draw) or 0 (loss) for you.

// Stockfish settings that play at roughly `elo`. From 1320 up Stockfish's own
// Elo limiter is calibrated; below it, a shallow search plus some random moves.
function botForElo(elo) {
  if (elo >= 1320) return { limit: Math.min(3190, Math.round(elo)), movetime: Math.round(500 + Math.min(1, (elo - 1320) / 1500) * 700) };
  const depth = elo < 600 ? 1 : elo < 900 ? 2 : elo < 1100 ? 4 : 6;
  const random = Math.max(0, Math.min(0.45, ((1320 - elo) / 1320) * 0.48));
  return { skill: 0, depth, random };
}

// Believable online-style names for opponents, picked from a seed
const NAME_A = ["Swift", "Quiet", "Iron", "Silent", "Royal", "Dark", "Lucky", "Clever", "Wild", "Frozen", "Golden", "Rapid", "Brave", "Sneaky", "Cosmic", "Shadow", "Storm", "Crimson", "Arctic", "Thunder"];
const NAME_B = ["Rook", "Knight", "Bishop", "Pawn", "Queen", "Castle", "Gambit", "Fork", "Tempo", "Check", "Endgame", "Opening", "Blitz", "Fianchetto", "Sicilian", "Zugzwang", "Mate", "Pin", "Skewer", "Tactic"];
function opponentName(seed) {
  let s = Math.abs(seed | 0) || 1;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const n = NAME_A[Math.floor(r() * NAME_A.length)] + NAME_B[Math.floor(r() * NAME_B.length)];
  return r() < 0.55 ? n + Math.floor(r() * 99 + 1) : n;
}

function startMatch(root, opts) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const myColor = opts.color === "random" || !opts.color ? (Math.random() < 0.5 ? "w" : "b") : opts.color;
  const oppColor = myColor === "w" ? "b" : "w";
  const bot = { ...botForElo(opts.opp.elo), name: opts.opp.name, elo: opts.opp.elo };
  const game = new Chess();
  const base = opts.clock ? opts.clock.base : 0, inc = opts.clock ? opts.clock.inc : 0;
  const clocks = { w: base, b: base };
  let turnStart = null, selected = null, over = false, thinking = false;

  root.innerHTML = `
    <div class="game">
      <div class="boardcol">
        <div class="player" data-bar="opp"></div>
        <div class="board"></div>
        <div class="player" data-bar="me"></div>
      </div>
      <div class="side">
        ${opts.label ? `<div class="match-label">${opts.label}</div>` : ""}
        <div class="status"></div>
        <div class="moves"></div>
        <div class="row names-row">${squareNamesButton()}</div>
        <div class="row"><button type="button" data-resign>🏳 Resign</button></div>
      </div>
    </div>`;
  const $q = (sel) => root.querySelector(sel);

  const bar = (who) => {
    const p = who === "me" ? opts.me : opts.opp;
    const c = who === "me" ? myColor : oppColor;
    return `<div class="who"><span class="dot on"></span><b>${esc(p.name)}</b><span class="dim">${Math.round(p.elo)}</span>${who === "opp" ? `<span class="tag">${c === "w" ? "White" : "Black"}</span>` : ""}</div>
      ${base ? `<div class="clock" data-clock="${c}"></div>` : ""}`;
  };
  $q('[data-bar="opp"]').innerHTML = bar("opp");
  $q('[data-bar="me"]').innerHTML = bar("me");

  const live = () => {
    const c = { ...clocks };
    if (base && turnStart && !over) c[game.turn()] = Math.max(0, c[game.turn()] - (Date.now() - turnStart));
    return c;
  };
  const fmt = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  function draw() {
    $q(".board").innerHTML = boardHtml(game, myColor, selected);
    $q(".moves").innerHTML = movesHtml(game);
    $q(".moves").scrollTop = $q(".moves").scrollHeight;
    if (!over) $q(".status").textContent = game.turn() === myColor ? (game.in_check() ? "You're in check — your move" : "Your move") : `${opts.opp.name} is thinking…`;
    tick();
  }

  function tick() {
    if (!base) return;
    const c = live();
    for (const el of root.querySelectorAll("[data-clock]")) {
      const col = el.dataset.clock;
      const running = !over && turnStart && game.turn() === col;
      el.textContent = fmt(c[col]);
      el.className = `clock ${running ? "run" : ""} ${c[col] < 20000 && !over ? "low" : ""}`;
    }
    if (!over && turnStart) {
      if (c[myColor] <= 0) finish(0, "timeout");
      else if (c[oppColor] <= 0) finish(1, "timeout");
    }
  }
  const timer = setInterval(tick, 200);

  function spend(color) {
    if (base && turnStart) clocks[color] = Math.max(0, clocks[color] - (Date.now() - turnStart)) + inc;
    turnStart = Date.now(); // the clock starts after White's first move
  }

  function checkEnd() {
    if (!game.game_over()) return false;
    if (game.in_checkmate()) finish(game.turn() === myColor ? 0 : 1, "checkmate");
    else finish(0.5, game.in_stalemate() ? "stalemate" : game.in_threefold_repetition() ? "repetition" : game.insufficient_material() ? "insufficient material" : "50-move rule");
    return true;
  }

  function finish(score, reason) {
    if (over) return;
    over = true;
    clearInterval(timer);
    if (base && turnStart) clocks[game.turn()] = live()[game.turn()];
    $q("[data-resign]").hidden = true;
    draw();
    const word = score === 1 ? "You won" : score === 0 ? "You lost" : "Draw";
    $q(".status").innerHTML = `<span class="${score === 1 ? "up" : score === 0 ? "down" : ""}">${word}</span> by ${esc(reason)}.`;
    opts.onEnd && opts.onEnd({ score, reason, color: myColor, moves: game.history().length, history: game.history() });
  }

  async function botTurn() {
    if (over || game.turn() !== oppColor || thinking) return;
    thinking = true;
    draw();
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await botMove(bot, game);
      if (over) return;
      game.move({ from: res.move.from, to: res.move.to, promotion: res.move.promotion || "q" });
      spend(oppColor);
    } catch (err) {
      console.error(err);
      $q(".status").textContent = `The opponent couldn't move (${err.message}). Reload to try again.`;
      return;
    } finally { thinking = false; }
    draw();
    checkEnd();
  }

  $q(".board").addEventListener("click", (e) => {
    if (over || thinking || game.turn() !== myColor) return;
    handleBoardClick(e, game, myColor, selected, (mv) => {
      game.move(mv);
      spend(myColor);
      draw();
      if (!checkEnd()) botTurn();
    }, (sq) => { selected = sq; draw(); });
  });
  $q("[data-resign]").addEventListener("click", () => {
    if (!over && confirm("Resign this game?")) finish(0, "resignation");
  });
  document.addEventListener("squarenames", draw);

  draw();
  botTurn();
  return { resign: () => finish(0, "resignation"), get over() { return over; } };
}
