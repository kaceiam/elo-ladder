# Elo Ladder

**Play now:** https://kaceiam.github.io/elo-ladder/ — bots, or invite a friend anywhere with a link (`friend.html`).

Chess with Elo ratings. Play rated games online against random opponents or
friends, or practice against seven bots from 400 to 2800.

- **Online** (`/`): quick play pairs you with someone near your rating; or
  create a game and send a friend the link. Clocks, chat, draw offers, rematch
  and a shared leaderboard.
- **Bots** (`/index.html`): Stockfish 18 plays at each bot's rating. If you run
  [Ollama](https://ollama.com) on your own computer, the bots also talk.

## Run locally

Needs Node 18 or newer. No packages to install.

```
node server.js
```

Then open http://localhost:8080. On Windows you can double-click `start.cmd`.

## Deploy to Render (free)

1. Put these files in a GitHub repository (everything in this folder except `data/`).
2. On [render.com](https://render.com), choose **New → Blueprint**, connect the
   repository, and click **Apply**. `render.yaml` sets everything up.
3. Open the `https://….onrender.com` address Render gives you and share it.

On the free plan the server sleeps after 15 idle minutes (the next visit takes
about 30 seconds to wake it), and ratings reset when it restarts or redeploys.
To keep ratings, use a paid plan with a disk and set the `DATA_DIR`
environment variable to the disk's mount path.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on (hosts set this automatically) |
| `DATA_DIR` | `./data` | Where `players.json` (ratings and login tokens) is saved |

## Credits

Moves are checked with [chess.js](https://github.com/jhlywa/chess.js) (BSD-2).
Bots use [Stockfish](https://stockfishchess.org) via
[stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0), so this
project is GPL-3.0 as well.
