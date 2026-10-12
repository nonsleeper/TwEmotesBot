# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Twitch chat bot that drives two OBS Browser Source overlays: animated emotes (Twitch, BTTV, FFZ, 7TV) and first-message greetings with sounds. Plain CommonJS Node.js (18+), no build step, no tests, no linter. Code comments and the README are in Russian.

## Commands

- `npm install` — install deps (`dependencies.bat` does the same).
- `npm start` / `start.bat` — run `web-server.js` (control panel). This is the normal entry point; it opens the browser and auto-starts the bot after 2s.
- `tray\build.bat` — compile `EmotesBotTray.exe` (C# tray launcher, source in `tray/TrayApp.cs`, built with the csc bundled in Windows). It runs `web-server.js` hidden with `NO_BROWSER=1`, logs to `tray.log` next to `web-server.js`, polls `/api/status`, and on exit calls `/api/stop` then `taskkill /T`. It looks for `web-server.js` in `app\` next to the exe (release layout), falling back to the exe's own folder (this repo), and prefers `runtime\node.exe` over `node` on PATH.
- Upgrading users of the old flat layout (everything next to `start.bat`) is handled by the tray (`StartupMigrationThenStart` in `TrayApp.cs`): legacy files next to the exe → offer to move config/cache/greetings/sounds into `app\` and park old program files (`LegacyItems`) in `old_version\`; first run with no `app\bot-config.json` → offer to pick the old folder and copy from it (asked once, `.import-asked` flag); also available from the tray menu. Files are merged, never overwritten (except the config, backed up to `.bak`). For testing next to a live instance build with `csc /define:TESTBUILD` — separate mutex/name and panel port 3011 (the tray passes `WEB_PORT` to `web-server.js`).
- `powershell -ExecutionPolicy Bypass -File tray\make-release.ps1` — build `release\`: only `EmotesBotTray.exe` in the root, everything else in `release\app\`, Node in `release\runtime\`. User data in an existing release (`bot-config.json`, `cache`, `greetings`, `sounds`, `tray.log`) is preserved across rebuilds; new files must be added to its explicit copy list. `-Clean` builds a release to hand out: only `sounds` is kept, the rest of the personal data is moved to `release-userdata-<date>\` next to `release\` (never deleted).
- `npm run server` — run `server.js` (the bot itself) directly, without the control panel. Reads `bot-config.json` and env vars (`TWITCH_CHANNEL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `PORT`, optional `CONFIG` JSON).
- `npm run pack:special-sounds [-- "<folder>"]` — regenerate `special-sounds-packed.json` (base64-embeds the audio files of `<folder>`, default `sounds/Ящики`). The running bot picks up a new pack via «Обновить» in the panel's sounds card (`/api/sounds/reload`).

## Versions & updates

- The version lives only in `package.json` → `version`; `package.json` → `emotesBot.updateRepo` (`owner/name`) is the GitHub repo the panel checks. Release notes come from `CHANGELOG.md` (`## <version>` sections).
- Publishing: bump `version`, add the CHANGELOG section, commit, run `tray\publish-release.ps1` (`-DryRun` only builds). It builds `dist\EmotesBot` via `make-release.ps1 -OutDir … -NoSounds` (no `sounds\` folder — that third-party audio stays out of the public repo and releases; `special-sounds-packed.json` IS shipped in the release zip but is not in git, so it must exist locally when publishing; updates replace it like any program file, the previous one stays in `.update-backup`), zips it as `dist\EmotesBot-v<version>.zip`, pushes and runs `gh release create`.
- In the app, `updates.js` (used by `web-server.js`: `/api/version`, `/api/update/check`, `/api/update/install`) reads GitHub `releases/latest` (cached 1h; `UPDATE_API_BASE` / `UPDATE_REPO` env vars override it for local tests), downloads the `EmotesBot-v*.zip` asset with progress over WebSocket, copies `updater.ps1` to %TEMP% and launches it through `cmd /c start` — a detached Node child has no console, and Windows PowerShell exits immediately without one.
- The updater that runs is the one from the INSTALLED version (`updates.js` copies `app\updater.ps1`), so `updater.ps1` hands over to the `app\updater.ps1` from the downloaded archive when it differs (`-Chained -StageDir`): changes to the update procedure take effect in the same update.
- `updater.ps1` stops the bot (`/api/stop`), kills the tray by PID and anything running from the install dir, backs up program files to `.update-backup\`, replaces program files while keeping user data (its `$userData` list — keep it in sync with `make-release.ps1`), rolls back on error, writes `app\.update-result.json` (shown by the tray and, for 10 minutes, by the panel) and restarts the tray. Self-install only works when the panel was started by the tray in the release layout (the tray passes `TRAY_PID` and `INSTALL_DIR`); otherwise the panel links to the release page.
- Every new top-level program file must be added to the copy list in `make-release.ps1`, or updates will ship without it.

## Architecture

Two processes, two ports:

- **`web-server.js`** (port 3001, override with `WEB_PORT` env — handy for running a test panel next to a live one) — control panel. Serves `web-gui/`, owns `bot-config.json` (load/save via `/api/config`), and **spawns `server.js` as a child process**, passing the whole config as JSON in the `CONFIG` env var. Saving config while the bot runs restarts the child (`/api/restart` does the same on demand). WebSocket messages to the panel: `log` (child stdout/stderr), `status` (`running`, plus `starting` during start/restart), `config` (broadcast after every save), `emotes-updated` (`cache/emote_names.json` changed, via `fs.watchFile`). `/api/reset-session` proxies to the bot's `/api/session/reset`.
- **`web-gui/`** — plain JS, no framework. `app.js` keeps the last saved config in `state.saved` and treats the form as a draft (save bar + per-tab badges show the diff; Ctrl+S saves). Fields with `data-key` map 1:1 to config keys; lists use `createTagInput` / `createEmotePicker`. The Twitch connection status shown in the header is derived by regex-matching the bot's log lines in `inspectLog` — if you change those log messages in `server.js`, update the patterns.
- **`server.js`** (port from config, default 3000) — the bot. Connects anonymously (read-only) to Twitch chat via `tmi.js`, serves `overlay/` and `/sounds`, `/cache`, `/special-sound/:id`, and pushes events to overlays on three WebSocket paths: `/ws/emotes`, `/ws/greeting` and `/ws/game` (handled via a manual `server.on('upgrade')` router). Overlay pages are `overlay/emotes.html`, `overlay/greeting.html` and `overlay/game.html`.

Both servers bind to `127.0.0.1` only. Stopping the bot goes through `POST /api/shutdown` on the bot (it saves greetings and exits itself) because `ChildProcess.kill()` is a hard kill on Windows; `kill('SIGTERM')` is only the fallback. `POST /api/config` runs the body through `sanitizeConfig` in `web-server.js` — new options need an entry there too.

Adding a config option touches: the defaults in `server.js` and `DEFAULT_CONFIG` in `web-server.js`, `sanitizeConfig`, and in the panel a `data-key` field in `index.html` plus its tab in `KEY_TAB` (`app.js`). Overlay look/timing options (`emote*`, `greeting*` style keys) are not read by the overlays directly — `server.js` packs them into each WebSocket event (`size`/`displayDurationMs` on emotes, `style`/`displayMs`/`volume` on greetings).

Overlays support `?preview`: no WebSocket, events arrive via `postMessage` (same origin only). The panel serves `overlay/` at `/overlay` and embeds both pages in iframes for the live preview, so preview and OBS run the same rendering code. `overlay/animations.js` defines the greeting entrance animations (Web Animations API keyframes) as a UMD file: the overlay plays them, the panel uses them for the tile demos, and `web-server.js` `require`s it to validate `greetingAnimations` (a list — the overlay picks a random one per greeting, never the same twice in a row). `overlay/fonts.js` holds the Google Fonts list (all with Cyrillic; the overlay loads them on demand) and is shared by the overlay and the panel. Installed Windows fonts come from `GET /api/fonts` — `system-fonts.js` reads family names straight from the `name` table of the TTF/OTF/TTC files in `%WINDIR%\Fonts` and the per-user fonts folder (browsers can't enumerate fonts); names with characters `sanitizeConfig` would strip are excluded so every listed font round-trips. `system-fonts.js` is a separate file, so `tray/make-release.ps1` copies it explicitly.

Greeting sounds: the panel lists `sounds/` (`GET /api/sounds`), plays files via its own `/sounds` static route, opens folders with `POST /api/sounds/open` (path must resolve inside `sounds/`), and `POST /api/sounds/reload` proxies to the bot's `/api/sounds/reload`, which re-runs `loadSoundFiles()` — so new files are picked up without a restart.

Emote codes are case-sensitive everywhere (7TV/BTTV have distinct `LUL` / `lul`): `emoteMap`, the blacklist, the panel pickers and the boost key in `emotes.html`. Greeting keywords are the exception — they are words, matched lower-cased.

Config precedence in `server.js`: defaults/env → `bot-config.json` → `CONFIG` env override. The default config object is **duplicated** in `web-server.js` (`DEFAULT_CONFIG`) and `server.js` (`config`); add new options in both, and expose them in `web-gui/`.

### Chat message flow (`client.on("message")` in `server.js`)

1. Message containing a `greetingKeywords` word → if the user hasn't greeted this stream, broadcast a `greeting` event (random `greetingEmotes` emote + sound) and mark them greeted; otherwise ignored. Greeting messages never produce emote events.
2. Otherwise, emotes are found from raw tokens matched against `emoteMap` (code → URL, filled from all providers) plus Twitch native emotes from `tags.emotes`; blacklisted codes are dropped.
3. Anti-spam (`emoteSpamLimit` per `emoteSpamWindow` seconds, per user) gates a `emote` broadcast, one event per repeat.

`loadAllEmotesForChannel` runs at startup: Twitch app token → resolve channel id → Twitch global/channel → BTTV/FFZ/7TV global/channel. Requires `twitchClientId`/`twitchClientSecret`.

Providers can be unreachable (7TV is blocked in Russia without a VPN — often as a silent hang, not a refused connection). So: the module-level `fetch` wrapper adds a 15s `AbortSignal.timeout` to every request that has no signal of its own; failed providers are recorded (`markSourceFailed`) and `restoreFailedSources` re-adds their emotes from `cache/provider_snapshot.json` (written by `saveProviderSnapshot` after each successful load — global sources shared, channel sources per channel id; falls back to `emote_names.json` entries with that `source` when no snapshot exists) using images already in `cache/emotes`. Greeting emotes fall back to the cached image too, and if none is available the greeting is still sent without `url` — the overlay renders text only. The panel shows both situations in the header status (log lines `... unavailable, using N cached emotes` and `[GREET] None of the greeting emotes are available`).

### «Текущая игра» (`overlay/game.html`, 1920×1080)

`updateStreamInfo` (every 30s, cached app token + channel id) feeds the stream's Twitch category into `updateCurrentGame`; `gameTick` (1s) adds elapsed time to `games/playtime.json[game_id].seconds` while a category is set (= stream is live) and the user isn't idle. Idle time comes from `idle-monitor.js`: one hidden long-lived `powershell` running `GetLastInputInfo`, printing ms since last input each second (exits itself when the bot's pid is gone; gamepads don't count). If it's unavailable, idle is `null` and the timer never pauses. State goes to `/ws/game` as `{ type: "game", game, seconds, running, style }` on connect, on change and every 15s; the overlay ticks locally in between. Panel: «Игра» tab, `/api/game/state` and `/api/game/playtime/:id` proxied to the bot (playtime is data, applied immediately, not config). In `?preview` the overlay itself handles dragging/arrow keys and posts `game-move` back to the panel; the panel sends `game-align`.

Saving config when **only** `game*` keys changed doesn't restart the bot: `web-server.js` POSTs them to the bot's `/api/game/overlay`, which rebuilds `GAME_STYLE` in place (falls back to a restart if that fails). `idle-monitor.js` is a separate file, so `tray/make-release.ps1` copies it explicitly; `games` is in its `$userData`.

### «Эдит» на вебке (`edit.js`, `obs.js`, `overlay/edit.html`)

Chat command (`editCommand`, default `!edit`; roles in `editWho`, checked by `canTriggerEdit` in `server.js`; `!edit stop` stops, repeating extends) or the panel's test button starts a timed session. No OBS plugin and no camera capture: the bot drives the user's own OBS camera source through OBS's built-in WebSocket server (`obs.js` — minimal obs-websocket v5 client on `ws`: auth, requests, `RequestBatch`, `InputVolumeMeters` events, reconnect).
- Beats: `BeatTracker` takes the selected audio input's peak level (~20 Hz from `InputVolumeMeters`), detects onsets, estimates tempo/phase (80–180 BPM) and predicts beats on a grid; `editLatencyMs` shifts the grid earlier. Unlocked → falls back to raw onsets.
- Effects (`EFFECTS`, ported from the user's offline `render.py` `motion()`): zoom/shake = crop + scale of the scene item (frame stays put, picture moves inside), tilt = rotation around the item centre (`buildTransform`/`centerOf`, handles alignment and bounds), flash/hue/mono/contrast = a `color_filter_v2` filter the bot adds to the camera (`FILTER_NAME`), enabled only during an edit. One `RequestBatch` per frame at ~30 fps; a frame is skipped while the previous batch is pending. RGB split / glitch / blur are impossible without a shader plugin.
- Safety: the original transform is saved to `cache/edit-restore.json` before an edit and restored at the end, on `/api/shutdown`/signals (`edit.shutdown()`) and — after a crash — on the next OBS connection (`restoreAfterCrash`).
- The overlay gets `edit-start` (camera rect in canvas coords + canvas size), `edit-beat` (emote URLs from recent chat via `rememberEmote`, fallback greeting emotes) and `edit-end` on `/ws/edit`.
- Panel «Эдит» tab: `/api/edit/state|sources|start|stop` proxied to the bot; `edit*`/`obs*` keys are applied live via the bot's `/api/edit/config` (no restart). Checkbox groups use `data-list="<key>"` (array values) — `listKeys()`/`listValues()` in `app.js`. `edit.js` and `obs.js` are in the copy list of `make-release.ps1`.
- Gotcha: on Windows, Node 24's `fs.rmSync` silently does nothing when the path contains non-ASCII characters (this repo lives in «Новая папка»); delete files with `fs.unlinkSync`.

### Persistent state (all gitignored)

- `cache/emotes/` — downloaded emote images (png/gif) served via `/cache`; `cache/emote_names.json` maps code → id and is what the panel's `/api/emotes` returns.
- `greetings/stream_<id>.json` — who was greeted in the current stream (keyed by live stream id from the Twitch API, so greetings reset per stream); also expires by `greetingExpireDays`, and old files are cleaned by `oldFilesExpireDays`.
- `games/playtime.json` — total time per Twitch category id (`name`, `boxArt` template, `seconds`, `lastPlayed`); saved debounced (30s) and on shutdown.
- `bot-config.json` — live config (contains the Twitch client secret); `bot-config.example.json` is the template.

### Sounds

`sounds/<pack>/` folders are loaded at startup for random greeting sounds. A special user (`SPECIAL_GREETING_USER` constant in `server.js`) gets sounds from `special-sounds-packed.json` instead, served from memory at `/special-sound/:id`.
