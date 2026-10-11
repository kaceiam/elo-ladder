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
- **Age rating** (answer honestly; nothing else in the app is mature):
  - Violence, horror, sexual content, profanity, drugs, alcohol, gambling, contests, medical: **None / No**
  - Unrestricted web access: **No** · Advertising: **No** · In-app purchases: **No**
  - **Messaging and chat: No.** There is no chat of any kind; players can only tap "Ready" before a game.
  - **User-generated content: Yes, player names only** (word-filtered, with Report and Block). Nothing else a player creates is shown to others.
  - Parental controls: **No** · Age assurance: **No** (ages are self-reported)
  - ⚠️ Check the rating Apple shows before saving. The app has a "12 and under" group, so if Apple's result is **13+ or higher**, stop and tell Kace's dad before submitting.
- **Privacy policy URL**: https://kaceiam.github.io/elo-ladder/privacy.html
- **Support URL**: https://kaceiam.github.io/elo-ladder/support.html
- **Support email** (reports and App Review contact): keyacesoftware@gmail.com
- **Marketing URL**: https://kaceiam.github.io/elo-ladder/

## App Privacy ("nutrition label")
Choose **"Data Not Collected"**. Everything is stored on the device; there are no accounts, ads, analytics or tracking. The player's age is self-reported, stays on the device only, and is used only to pick a quick-match age group (the group is part of a temporary matching code on the PeerJS connection broker, never sent to or stored by us).

## Promotional text (170 max)
New: Sunday Cup tournaments every week, ranked matches from Bronze to Grandmaster, and an Elo Test that finds your real rating in four quick games.

## Description (4000 max)
Climb the Elo ladder — from your very first move to grandmaster-level chess.

PLAY 7 BOTS AT EVERY LEVEL
Seven opponents powered by Stockfish 18, from Pebble (400) to Oracle (2800). Strong bots use Stockfish's calibrated rating limiter, so a 1600 bot really plays like a 1600.

RANKED MATCHES
Play five placement games, then climb Bronze, Silver, Gold, Platinum, Diamond, Master and Grandmaster — with real chess clocks.

SUNDAY CUP — EVERY WEEK
A 5-round tournament against 31 bot rivals every Sunday, with live standings, trophies, and an exclusive Champion gold board for the winner.

280 LESSONS
Seven training courses with 1,400 exercises you solve right on the board: how the pieces move, checkmate patterns, tactics, 40 openings, middlegames, endgames and a master class. Hints, solutions, and a star for every perfect lesson.

FIND YOUR REAL RATING
The Elo Test plays four quick games against a bot that adapts to you, then tells you your rating. Replay every game move by move.

PLAY A FRIEND ANYWHERE
Send an invite link and play a friend wherever they are, with clocks, draw offers and rematches.

MAKE IT YOURS
Ten board styles — from classic wood to glowing Neon and Galaxy — that you unlock by winning games. Square names on every square help new players learn chess notation.

Free. No account. No ads. No tracking.

## Keywords (100 max, comma-separated, no spaces)
chess,elo,stockfish,puzzles,tactics,openings,endgame,lessons,ranked,tournament,bots,board,checkmate

## What's New (version 1.13.0)
First release on the App Store: bots, ranked play, quick match by age group, Sunday Cup tournaments, 280 lessons, the Elo Test and unlockable boards. (Apple only shows "What's New" from the second version on.)

## Screenshots
Use the six images in `appstore/screenshots/` (1290 × 2796, iPhone 6.7"). Upload them in this order:
1. Home  2. Playing a bot  3. Training  4. Ranked  5. Board styles  6. Sunday Cup

## Review notes (App Review Information → Notes)
Elo Ladder is a chess app. No login is needed: on first launch you pick a name, a skill level and your age, then every feature works. The chess engine (Stockfish) runs on the device. "Online Play" has Quick match (bullet, blitz, rapid and 30/60-minute games against another player who picked the same time control at the same moment) and invite links for playing a friend (open an invite on two devices to test). The "Online lobby" option only appears when the developer's own game server is reachable, so reviewers won't see it. The Sunday Cup is a single-player tournament against bot opponents.

Child safety and user-generated content (Guideline 1.2): there is no chat or messaging of any kind — players can only tap "Ready" before a game, and any other message a modified client sends is ignored. The only user content is player names, which pass a word filter. Quick match only pairs players in the same age group (12 and under, 13–17, 18+). Age is self-reported at setup, kept on the device only, and used only for this matchmaking; there is no age verification. Every game has 🚩 Report (opens a private, pre-filled report email to keyacesoftware@gmail.com; reports are never public) and 🔇 Block (stops that player joining your invites or being matched with you). Reports are handled within 24 hours. Support page: https://kaceiam.github.io/elo-ladder/support.html

## Licenses
- Stockfish chess engine: GPL-3.0 — the app's full source code is public at https://github.com/kaceiam/elo-ladder
- chess.js: BSD-2-Clause
- Puzzles: Lichess puzzle database, CC0 (public domain)
