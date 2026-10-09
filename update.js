// Live updates. Every page checks version.json every 30 seconds. When the
// update number goes up, a banner counts down and then restarts the app into
// the new version, which shows a "What's new" box once.
//
// To ship an update: raise "version" in version.json, fill in "title" and
// "notes", and publish. Pages can delay the restart while something must not
// be interrupted by setting window.updateBusy = () => true/false.
//
// While an update is being built, version.json can announce it ahead of time:
//   "upcoming": { "version": 3, "title": "…", "eta": "2026-10-09T18:30:00Z" }
// and every page shows a "being built — ready in mm:ss" bar until it ships.

(function () {
  const POLL_MS = 30_000;
  const SEEN_KEY = "elo-update-seen";
  let loadedVersion = null; // the version this page was opened with
  let pending = null;       // a newer version we're counting down to
  let deadline = 0;
  let upcoming = null;      // an update that's still being built
  let hiddenUpcoming = null;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  async function fetchVersion() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  function showVersionLabel(v) {
    for (const el of document.querySelectorAll("[data-version]")) el.textContent = `Update ${v.version}`;
  }

  // ---------- countdown banner ----------

  const clockText = (secs) => {
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };

  // "Update N is being built" bar, counting down to the estimated finish
  let buildBar = null;
  function renderBuildBar() {
    const show = upcoming && !pending && hiddenUpcoming !== upcoming.version;
    if (!show) { if (buildBar) { buildBar.remove(); buildBar = null; } return; }
    if (!buildBar) {
      buildBar = document.createElement("div");
      buildBar.className = "update-bar building";
      buildBar.innerHTML = `<div class="update-text"></div><button type="button" title="Hide">✕</button>`;
      buildBar.querySelector("button").addEventListener("click", () => { hiddenUpcoming = upcoming.version; renderBuildBar(); });
      document.body.prepend(buildBar);
    }
    const eta = Date.parse(upcoming.eta);
    const left = Number.isFinite(eta) ? Math.max(0, Math.ceil((eta - Date.now()) / 1000)) : null;
    const what = upcoming.title ? ` — ${esc(upcoming.title)}` : "";
    buildBar.querySelector(".update-text").innerHTML = left
      ? `🛠 <b>Update ${upcoming.version}</b> is being built${what}. Ready in about <b>${clockText(left)}</b>`
      : `🛠 <b>Update ${upcoming.version}</b> is almost ready${what}. Finishing up…`;
  }

  let bar = null;
  function renderBar() {
    renderBuildBar();
    if (!pending) return;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "update-bar";
      bar.innerHTML = `<div class="update-text"></div><button class="primary" type="button">Restart now</button>`;
      bar.querySelector("button").addEventListener("click", restart);
      document.body.prepend(bar);
    }
    const busy = typeof window.updateBusy === "function" && window.updateBusy();
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const what = pending.title ? ` — ${esc(pending.title)}` : "";
    bar.querySelector(".update-text").innerHTML = left > 0
      ? `🔄 <b>Update ${pending.version}</b> is coming${what}. Restarting in <b>${clock}</b>`
      : busy
        ? `🔄 <b>Update ${pending.version}</b> is ready${what}. It installs as soon as your game ends.`
        : `🔄 Installing <b>Update ${pending.version}</b>…`;
    bar.querySelector("button").hidden = busy && left <= 0;
    if (left <= 0 && !busy) restart();
  }

  function restart() {
    const url = new URL(location.href);
    url.searchParams.set("v", pending ? pending.version : Date.now());
    location.replace(url);
  }

  // ---------- what's new ----------

  function whatsNew(v) {
    const seen = parseInt(store.get(SEEN_KEY), 10);
    store.set(SEEN_KEY, String(v.version));
    if (!seen || seen >= v.version) return; // first visit, or nothing new
    const box = document.createElement("div");
    box.className = "update-modal";
    box.innerHTML = `
      <div class="update-card" role="dialog" aria-label="What's new">
        <div class="dim small">You're on the newest version</div>
        <h2 style="margin: 4px 0 8px">✨ Update ${v.version}${v.title ? ` — ${esc(v.title)}` : ""}</h2>
        ${(v.notes || []).length ? `<ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        <button class="primary" type="button">Let's play</button>
      </div>`;
    box.addEventListener("click", (e) => { if (e.target === box || e.target.tagName === "BUTTON") box.remove(); });
    document.body.append(box);
  }

  // ---------- checking ----------

  async function check() {
    const v = await fetchVersion();
    if (!v || typeof v.version !== "number") return;
    upcoming = v.upcoming && v.upcoming.version > v.version ? v.upcoming : null;
    if (loadedVersion === null) {
      loadedVersion = v.version;
      showVersionLabel(v);
      whatsNew(v);
      return;
    }
    if (v.version > loadedVersion && (!pending || v.version > pending.version)) {
      pending = v;
      deadline = Date.now() + (v.countdown || 60) * 1000;
    }
  }

  // Inside the App Store app the files are built in; updates come through the App Store
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;

  setInterval(check, POLL_MS);
  setInterval(renderBar, 250);
  // Phones pause background tabs; check again as soon as the app is opened
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  check();
})();
