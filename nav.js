// The menu on every page: a top bar (tabs + profile) and, on phones, an
// app-style tab bar at the bottom. Also the ranked tiers and the profile box
// (change name, wins, unlocked boards, trophies). Needs board.js.

// ---------- ranked tiers ----------

const TIERS = [
  { name: "Bronze", min: 0, color: "#d08a4a", icon: "♙", splits: [0, 700, 850] },
  { name: "Silver", min: 1000, color: "#c9d1dc", icon: "♘" },
  { name: "Gold", min: 1300, color: "#ffcf40", icon: "♗" },
  { name: "Platinum", min: 1600, color: "#5fd3c6", icon: "♖" },
  { name: "Diamond", min: 1900, color: "#7cc4ff", icon: "♕" },
  { name: "Master", min: 2200, color: "#b98bff", icon: "♔" },
  { name: "Grandmaster", min: 2500, color: "#ff5c7a", icon: "♛" },
];
// Tier, division (III → II → I) and progress toward the next step
function tierOf(elo) {
  let i = TIERS.length - 1;
  while (i > 0 && elo < TIERS[i].min) i--;
  const t = TIERS[i], next = TIERS[i + 1];
  if (!next) return { ...t, label: t.name, rank: i * 3, progress: Math.min(1, (elo - t.min) / 500), next: null };
  const splits = t.splits || [t.min, t.min + (next.min - t.min) / 3, t.min + (2 * (next.min - t.min)) / 3];
  let d = 0;
  while (d < 2 && elo >= splits[d + 1]) d++;
  const lo = splits[d], hi = d < 2 ? splits[d + 1] : next.min;
  const DIV = ["III", "II", "I"];
  return {
    ...t, label: `${t.name} ${DIV[d]}`, rank: i * 3 + d, progress: (elo - lo) / (hi - lo),
    next: d < 2 ? { label: `${t.name} ${DIV[d + 1]}`, at: hi } : { label: `${next.name} III`, at: next.min },
  };
}

// ---------- your profile (shared with Play a Friend) ----------

const NAV_PROFILE_KEY = "elo-friend-profile";
const NAV_NAME_COOLDOWN = 180 * 24 * 3600 * 1000;
function readProfile() { try { return JSON.parse(localStorage.getItem(NAV_PROFILE_KEY)) || {}; } catch { return {}; } }
function writeProfile(p) { try { localStorage.setItem(NAV_PROFILE_KEY, JSON.stringify(p)); } catch {} }
function myDisplayName() { return readProfile().name || "You"; }

function rankedInfo() {
  try {
    const r = JSON.parse(localStorage.getItem("elo-ranked"));
    if (r && r.games >= 5) return { ...tierOf(r.elo), elo: Math.round(r.elo), placed: true };
    if (r && r.games) return { label: `Placement ${r.games}/5`, color: "#9aa0c0", icon: "?", placed: false };
  } catch {}
  return null;
}

// ---------- Sunday Cup timing ----------

function cupStatus() {
  const now = new Date();
  if (now.getDay() === 0) return { live: true, text: "LIVE" };
  const next = new Date(now);
  next.setDate(now.getDate() + ((7 - now.getDay()) % 7));
  next.setHours(0, 0, 0, 0);
  const ms = next - now, d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return { live: false, next, text: d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`, long: `${d ? `${d} day${d > 1 ? "s" : ""}, ` : ""}${h} hour${h === 1 ? "" : "s"} and ${m} minute${m === 1 ? "" : "s"}` };
}

// ---------- the menu ----------

const NAV_PAGES = [
  { href: "bots.html", icon: "♚", label: "Play Bots" },
  { href: "ranked.html", icon: "⚔️", label: "Ranked" },
  { href: "tournament.html", icon: "🏆", label: "Tournament", cup: true },
  { href: "friend.html", icon: "🌐", label: "Online Play", also: ["online.html"] },
  { href: "training.html", icon: "🎓", label: "Training" },
];

function navHtml() {
  const here = location.pathname.split("/").pop() || "index.html";
  const cup = cupStatus();
  const tab = (p, cls) => {
    const active = p.href === here || (p.also || []).includes(here);
    const badge = p.cup ? `<span class="nav-badge ${cup.live ? "live" : ""}">${cup.live ? "LIVE" : cup.text}</span>` : "";
    return `<a class="${cls} ${active ? "active" : ""}" href="${p.href}"><span class="nav-ico">${p.icon}</span><span class="nav-label">${p.label}</span>${badge}</a>`;
  };
  return `
    <nav class="topnav" aria-label="Main menu">
      <a class="nav-brand" href="index.html"><img src="icons/icon-192.png" alt=""><span>Elo Ladder</span></a>
      <div class="nav-tabs">${NAV_PAGES.map((p) => tab(p, "nav-tab")).join("")}</div>
      <button type="button" class="nav-elo" data-elo-panel title="Your ratings">📈 ELO</button>
      <button type="button" class="nav-profile" data-profile></button>
    </nav>
    <nav class="tabbar" aria-label="Main menu">${NAV_PAGES.map((p) => tab(p, "tab-item")).join("")}</nav>`;
}

function refreshNav() {
  const btn = document.querySelector(".nav-profile");
  if (!btn) return;
  const name = myDisplayName(), stats = playerStats(), rank = rankedInfo();
  btn.innerHTML = `
    <span class="avatar-sm" style="--c: ${rank && rank.placed ? rank.color : "#7b5cff"}">${name === "You" ? "👤" : name[0].toUpperCase()}</span>
    <span class="nav-who"><b>${name.replace(/[<>&"]/g, "")}</b><span>${rank ? `<i style="color: ${rank.color}">${rank.label}</i> · ` : ""}🏆 ${stats.wins} win${stats.wins === 1 ? "" : "s"}</span></span>`;
}

// ---------- profile box ----------

function showProfile() {
  const p = readProfile(), stats = playerStats(), rank = rankedInfo();
  const bots = (() => { try { return JSON.parse(localStorage.getItem("elo-ladder-v1")).me; } catch { return null; } })();
  const unlocked = Object.keys(BOARD_THEMES).filter((id) => themeUnlocked(id, stats));
  const nextBoard = Object.entries(BOARD_THEMES).filter(([id]) => !unlocked.includes(id)).sort((a, b) => a[1].wins - b[1].wins)[0];
  const lockedName = p.name && p.nameSetAt;
  const canChange = !lockedName || Date.now() >= (p.nameChangedAt || 0) + NAV_NAME_COOLDOWN;
  const nextChange = new Date((p.nameChangedAt || 0) + NAV_NAME_COOLDOWN).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const medal = (place) => (place === 1 ? "🏆" : place === 2 ? "🥈" : place === 3 ? "🥉" : place <= 8 ? "🎖️" : "📜");
  const box = document.createElement("div");
  box.className = "update-modal";
  box.innerHTML = `
    <div class="update-card profile-card" role="dialog" aria-label="Your profile">
      <div class="profile-head">
        <span class="avatar-lg" style="--c: ${rank && rank.placed ? rank.color : "#7b5cff"}">${p.name ? p.name[0].toUpperCase() : "👤"}</span>
        <div>
          <div class="profile-name">${p.name ? p.name.replace(/[<>&"]/g, "") : "Pick a name"}</div>
          <div class="dim small">${rank ? `<b style="color: ${rank.color}">${rank.label}</b>${rank.placed ? ` · ${rank.elo} ranked` : ""}` : "Not ranked yet"}</div>
        </div>
      </div>
      <form class="row" data-name-form style="margin-top: 12px">
        <input type="text" maxlength="20" placeholder="${lockedName ? "New name" : "Pick your name"}" ${canChange ? "" : "disabled"}>
        <button class="primary" ${canChange ? "" : "disabled"}>${lockedName ? "✏️ Change name" : "Save name"}</button>
      </form>
      <div class="dim small" data-name-note>${!lockedName ? "Your name stays with you — after that, one change every 180 days." : canChange ? "You can change your name now (then not again for 180 days)." : `Next name change: ${nextChange}`}</div>
      <div class="err" data-name-err></div>
      <div class="profile-stats">
        <div><b>${stats.wins}</b><span>Total wins</span></div>
        <div><b>${bots ? Math.round(bots.elo) : "—"}</b><span>Bot rating</span></div>
        <div><b>${rank && rank.placed ? rank.elo : "—"}</b><span>Ranked</span></div>
        <div><b>${p.elo ? Math.round(p.elo) : "—"}</b><span>Friend games</span></div>
      </div>
      <div class="profile-boards">
        <div><b>🎨 Boards unlocked: ${unlocked.length} / ${Object.keys(BOARD_THEMES).length}</b></div>
        ${nextBoard ? `<div class="dim small">Next: <b>${nextBoard[1].name}</b> at ${nextBoard[1].wins} wins (${Math.min(stats.wins, nextBoard[1].wins)}/${nextBoard[1].wins})</div>
          <div class="bar"><i style="width: ${Math.min(100, (stats.wins / nextBoard[1].wins) * 100)}%"></i></div>` : `<div class="dim small">You've unlocked every board! 👑</div>`}
        <button type="button" data-board-themes style="margin-top: 8px">🎨 Board style</button>
      </div>
      <div class="profile-trophies"><b>🏆 Sunday Cup trophies</b>
        <div>${stats.trophies.length ? stats.trophies.map((t) => `<span class="trophy" title="Sunday Cup ${t.week}: place ${t.place}">${medal(t.place)} <small>#${t.place} · ${t.week}</small></span>`).join("") : `<span class="dim small">None yet — play the Sunday Cup!</span>`}</div>
      </div>
      <button type="button" class="primary" data-close style="margin-top: 14px">Close</button>
    </div>`;
  box.addEventListener("click", (e) => { if (e.target === box || e.target.closest("[data-close]")) box.remove(); });
  box.querySelector("[data-name-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = box.querySelector("[data-name-form] input").value.trim();
    const err = box.querySelector("[data-name-err]");
    err.textContent = "";
    const rule = window.EloNames ? EloNames.checkName(name) : { ok: /^[A-Za-z0-9 _-]{2,20}$/.test(name), reason: "Names are 2–20 letters, numbers, spaces, _ or -" };
    if (!rule.ok) { err.textContent = rule.reason; return; }
    if (!confirm(lockedName ? `Change your name to "${name}"? You won't be able to change it again for 180 days.` : `Play as "${name}"? This name stays with you.`)) return;
    // The online lobby renames your server account too
    if (typeof window.onlineRename === "function") {
      try { await window.onlineRename(name); } catch (ex) { err.textContent = ex.message; return; }
    }
    const fresh = readProfile();
    if (fresh.name && fresh.nameSetAt) fresh.nameChangedAt = Date.now(); else fresh.nameSetAt = Date.now();
    fresh.name = name;
    writeProfile(fresh);
    box.remove();
    refreshNav();
    document.dispatchEvent(new Event("profilechange"));
    showProfile();
  });
  document.body.append(box);
}

// ---------- the ELO panel: all your ratings in one place ----------

function showEloPanel() {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const bots = read("elo-ladder-v1"), friend = read(NAV_PROFILE_KEY), ranked = read("elo-ranked"), test = read("elo-test");
  const botElo = Math.round((bots.me || {}).elo || 1200), friendElo = Math.round(friend.elo || 1200);
  const rank = rankedInfo();
  const lastTest = (test.runs || []).slice(-1)[0];
  const online = typeof window.onlineMe === "function" ? window.onlineMe() : null;
  const card = (icon, title, elo, sub, action) => `
    <div class="elo-card"><span class="elo-ico">${icon}</span>
      <div><div class="dim small">${title}</div><div class="elo-num">${elo}</div><div class="dim small">${sub}</div></div>${action}</div>`;
  const box = document.createElement("div");
  box.className = "update-modal";
  const render = () => {
    const b = read("elo-ladder-v1"), f = read(NAV_PROFILE_KEY);
    const be = Math.round((b.me || {}).elo || 1200), fe = Math.round(f.elo || 1200);
    box.innerHTML = `
      <div class="update-card elo-panel" role="dialog" aria-label="Your ratings">
        <div class="row" style="justify-content: space-between"><h2 style="margin: 0">📈 Your ELO</h2><button type="button" data-close>✕</button></div>
        <p class="dim" style="margin: 4px 0 12px">Every mode keeps its own rating. Not sure what yours should be? Take the Elo Test.</p>
        <a class="elo-test-btn" href="elotest.html"><span>🧪</span><span><b>Take the Elo Test</b><br><small>4 quick games against a bot that adapts to you${lastTest ? ` · last result: <b>${lastTest.result}</b>` : ""}</small></span><span>→</span></a>
        <div class="elo-cards">
          ${card("♚", "Bot games", be, `${rankOf(be)} · ${(b.games || []).length} games`, `<button type="button" data-set="bots">✏️ Change</button>`)}
          ${card("🌐", "Friend games", fe, `${rankOf(fe)} · ${(f.history || []).length} games`, `<button type="button" data-set="friend">✏️ Change</button>`)}
          ${card("⚔️", "Ranked", rank && rank.placed ? rank.elo : "—", rank ? `<span style="color: ${rank.color}">${rank.label}</span> · earned by playing` : "Play 5 placement games", `<a class="btn" href="ranked.html">Play ranked</a>`)}
          ${online ? card("🏟", "Online lobby", online.elo, "Only an admin can change this one", "") : ""}
        </div>
      </div>`;
  };
  render();
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest("[data-close]")) return box.remove();
    const s = e.target.closest("[data-set]");
    if (!s) return;
    if (s.dataset.set === "bots") {
      const b = read("elo-ladder-v1");
      showRatingPicker((b.me || {}).elo || 1200, (elo) => {
        b.me = { ...(b.me || { games: 0 }), elo };
        try { localStorage.setItem("elo-ladder-v1", JSON.stringify(b)); } catch {}
        render();
        document.dispatchEvent(new Event("ratingchange"));
      });
    } else {
      const f = read(NAV_PROFILE_KEY);
      showRatingPicker(f.elo || 1200, (elo) => {
        f.elo = elo;
        writeProfile(f);
        render();
        document.dispatchEvent(new Event("profilechange"));
      });
    }
  });
  document.body.append(box);
}

// ---------- first-time setup: name, level and age ----------
// Everyone picks these once before playing. The level sets the starting
// rating; the age stays on this device, and only the age group is used, so
// quick matches pair players with others their age.

const SETUP_VERSION = 1;
const LEVELS = [
  { name: "Beginner", elo: 600, note: "Just learning how the pieces move" },
  { name: "Novice", elo: 900, note: "Know the rules, still learning tactics" },
  { name: "Intermediate", elo: 1200, note: "Play regularly, know some openings" },
  { name: "Advanced", elo: 1500, note: "Strong club player" },
  { name: "Expert", elo: 1800, note: "Tournament player" },
  { name: "Master", elo: 2100, note: "Master-level strength" },
  { name: "Grandmaster", elo: 2500, note: "The very best" },
];
const AGE_GROUPS = [
  { id: "kids", label: "12 and under", max: 12 },
  { id: "teens", label: "13–17", max: 17 },
  { id: "adults", label: "18 and over", max: Infinity },
];
function ageGroupOf(age) { return AGE_GROUPS.find((g) => age <= g.max).id; }
function myAgeGroup() { return readProfile().ageGroup || null; }

function needsSetup() { return (readProfile().setup || 0) < SETUP_VERSION; }

function showSetup() {
  if (document.querySelector(".setup-card")) return;
  let level = null;
  const box = document.createElement("div");
  box.className = "update-modal";
  box.innerHTML = `
    <form class="update-card setup-card" role="dialog" aria-label="Set up your player">
      <h2 style="margin: 0 0 4px">♞ Welcome to Elo Ladder</h2>
      <p class="dim" style="margin: 0 0 14px">Set up your player to start playing.</p>
      <label class="setup-label">1. Pick a name</label>
      <input type="text" data-setup-name maxlength="20" placeholder="Your player name" autocomplete="off">
      <div class="dim small" style="margin-top: 4px">2–20 letters or numbers. You can change it once, then once every 180 days.</div>
      <label class="setup-label">2. How good are you?</label>
      <div class="setup-levels">${LEVELS.map((l, i) => `<button type="button" data-level="${i}"><b>${l.name}</b><span>${l.note}</span></button>`).join("")}</div>
      <label class="setup-label">3. How old are you?</label>
      <input type="number" data-setup-age min="4" max="120" inputmode="numeric" placeholder="Your age">
      <div class="dim small" style="margin-top: 4px">Quick match puts you with players your age. Your age stays on this phone.</div>
      <div class="err" data-setup-err></div>
      <button class="primary" style="margin-top: 14px; width: 100%">Start playing</button>
    </form>`;
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-level]");
    if (!b) return;
    level = LEVELS[+b.dataset.level];
    for (const x of box.querySelectorAll("[data-level]")) x.classList.toggle("on", x === b);
  });
  box.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const err = box.querySelector("[data-setup-err]");
    const name = box.querySelector("[data-setup-name]").value.trim();
    const age = parseInt(box.querySelector("[data-setup-age]").value, 10);
    const rule = window.EloNames ? EloNames.checkName(name) : { ok: /^[A-Za-z0-9 _-]{2,20}$/.test(name), reason: "Names are 2–20 letters, numbers, spaces, _ or -" };
    if (!rule.ok) { err.textContent = rule.reason; return; }
    if (!level) { err.textContent = "Pick how good you are."; return; }
    if (!(age >= 4 && age <= 120)) { err.textContent = "Enter your age (a number)."; return; }
    const p = readProfile();
    Object.assign(p, { name, nameSetAt: Date.now(), nameChangedAt: undefined, level: level.name, elo: level.elo,
      age, ageGroup: ageGroupOf(age), setup: SETUP_VERSION });
    if (!p.history) p.history = [];
    if (!p.games) p.games = 0;
    writeProfile(p);
    // New players start their bot rating at their level too
    try {
      const b = JSON.parse(localStorage.getItem("elo-ladder-v1")) || {};
      if (!(b.games || []).length) { b.me = { ...(b.me || { games: 0 }), elo: level.elo }; localStorage.setItem("elo-ladder-v1", JSON.stringify(b)); }
    } catch {}
    box.remove();
    refreshNav();
    document.dispatchEvent(new Event("profilechange"));
    document.dispatchEvent(new Event("ratingchange"));
  });
  document.body.append(box);
  setTimeout(() => box.querySelector("[data-setup-name]").focus(), 50);
}

// ---------- start ----------

(function () {
  if (typeof document === "undefined") return;
  document.body.classList.add("has-nav");
  document.body.insertAdjacentHTML("afterbegin", navHtml());
  refreshNav();
  if (needsSetup()) showSetup();
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-profile]")) showProfile();
    if (e.target.closest("[data-elo-panel]")) showEloPanel();
  });
  // Keep the Sunday Cup badge fresh
  setInterval(() => {
    const cup = cupStatus();
    for (const b of document.querySelectorAll(".nav-badge")) { b.textContent = cup.live ? "LIVE" : cup.text; b.classList.toggle("live", cup.live); }
  }, 60_000);
  setTimeout(checkUnlocks, 800);
})();
