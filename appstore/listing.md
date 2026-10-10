# Elo Ladder — App Store listing

Copy these into App Store Connect (My Apps → Elo Ladder → App Information / version page).

## Basics
- **Name** (30 max): Elo Ladder: Chess Bots & Ranks
  - If that's taken, try: Elo Ladder Chess
- **Subtitle** (30 max): Climb from beginner to master
- **Bundle ID**: io.github.kaceiam.eloladder
- **SKU**: eloladder-1
- **Primary category**: Games → Board
- **Secondary category**: Education
- **Price**: Free
- **Age rating**: 4+ (answer "None" to every question)
- **Privacy policy URL**: https://kaceiam.github.io/elo-ladder/privacy.html
- **Support URL**: https://github.com/kaceiam/elo-ladder/issues
- **Support email** (reports and App Review contact): keyacesoftware@gmail.com
- **Marketing URL**: https://kaceiam.github.io/elo-ladder/

## App Privacy ("nutrition label")
Choose **"Data Not Collected"**. Everything is stored on the device; there are no accounts, ads, analytics or tracking.

## Promotional text (170 max)
New: Sunday Cup tournaments every week, ranked matches from Bronze to Grandmaster, and an Elo Test that finds your real rating in four quick games.

## Description (4000 max)
Climb the Elo ladder — from your very first move to grandmaster-level chess.

PLAY 7 BOTS AT EVERY LEVEL
Seven opponents powered by Stockfish 18, from Pebble (400) to Oracle (2800). Strong bots use Stockfish's calibrated rating limiter, so a 1600 bot really plays like a 1600.

RANKED MATCHES
Play five placement games, then climb Bronze, Silver, Gold, Platinum, Diamond, Master and Grandmaster — with real chess clocks.

SUNDAY CUP — EVERY WEEK
A 5-round, 32-player tournament every Sunday, with live standings, trophies, and an exclusive Champion gold board for the winner.

280 LESSONS
Seven training courses with 1,400 exercises you solve right on the board: how the pieces move, checkmate patterns, tactics, 40 openings, middlegames, endgames and a master class. Hints, solutions, and a star for every perfect lesson.

FIND YOUR REAL RATING
The Elo Test plays four quick games against a bot that adapts to you, then tells you your rating. Replay every game move by move.

PLAY A FRIEND ANYWHERE
Send an invite link and play a friend wherever they are, with clocks, chat, draw offers and rematches.

MAKE IT YOURS
Ten board styles — from classic wood to glowing Neon and Galaxy — that you unlock by winning games. Square names on every square help new players learn chess notation.

Free. No account. No ads. No tracking.

## Keywords (100 max, comma-separated, no spaces)
chess,elo,stockfish,puzzles,tactics,openings,endgame,lessons,ranked,tournament,bots,board,checkmate

## What's New (version 1.7.0)
First release on the App Store: bots, ranked play, Sunday Cup tournaments, 280 lessons, the Elo Test and unlockable boards.

## Screenshots
Use the six images in `appstore/screenshots/` (1290 × 2796, iPhone 6.7"). Upload them in this order:
1. Home  2. Playing a bot  3. Training  4. Ranked  5. Board styles  6. Sunday Cup

## Review notes (App Review Information → Notes)
Elo Ladder is a chess app. No login is needed — every feature works right away. The chess engine (Stockfish) runs on the device. "Online Play" connects two players directly with an invite link (open friend invites on two devices to test). The "Online lobby" option only appears when the developer's own game server is reachable, so reviewers won't see it.

User-generated content (Guideline 1.2): the only user content is in-game chat and player names. Chat and names pass a word filter; every game has 🚩 Report (online lobby: goes to the admin queue; Play a Friend: opens a private, pre-filled report email to keyacesoftware@gmail.com; reports are never public) and 🔇 Block (hides the player's messages and stops them joining your invites, challenging, friending or being matched with you). Reports are handled within 24 hours.

## Licenses
- Stockfish chess engine: GPL-3.0 — the app's full source code is public at https://github.com/kaceiam/elo-ladder
- chess.js: BSD-2-Clause
- Puzzles: Lichess puzzle database, CC0 (public domain)
