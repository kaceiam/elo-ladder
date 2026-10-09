// Copies just the web app (pages, scripts, styles, icons, lessons, engines)
// into www/ for the iPhone app. Server code, player data and tools stay out.
//
//   node tools/build-www.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "www");
const INCLUDE = [
  "index.html", "bots.html", "ranked.html", "tournament.html", "friend.html", "training.html", "elotest.html", "online.html", "privacy.html",
  "app.css", "config.js", "board.js", "bots.js", "elo.js", "match.js", "names.js", "nav.js", "pwa.js", "update.js",
  "manifest.webmanifest", "version.json", "icons", "vendor", "training",
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let files = 0;
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) throw new Error(`Missing ${item}`);
  fs.cpSync(src, path.join(OUT, item), { recursive: true });
  files += fs.statSync(src).isDirectory() ? fs.readdirSync(src, { recursive: true }).length : 1;
}
console.log(`www/ ready: ${files} files`);
