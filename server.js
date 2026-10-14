const tmi = require("tmi.js");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { startIdleMonitor } = require("./idle-monitor");

// У запросов к API нет своего таймаута: если провайдер молча режет соединение (7TV в РФ без VPN),
// бот ждал бы ответа бесконечно и так и не зашёл бы в чат. Запросы со своим signal не трогаем.
const FETCH_TIMEOUT_MS = 15000;
const fetch = (url, options = {}) =>
  import("node-fetch").then(({ default: fetch }) =>
    fetch(url, options.signal ? options : { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));

// Загрузка конфигурации из переменных окружения или значений по умолчанию
let config = {
  channel: process.env.TWITCH_CHANNEL || "your_channel",
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  port: parseInt(process.env.PORT) || 3000,
  greetingKeywords: ["привет", "здарова", "ку", "hiii", "hi"],
  greetingEmotes: ["hiii"],
  emoteBlacklist: [],
  emoteSpamLimit: 5,
  emoteSpamWindow: 20,
  emoteBoostOnSameFromDifferentUser: true,
  emoteBoostScalePercent: 20,
  greetingExpireDays: 1,
  oldFilesExpireDays: 7,
  emoteDisplaySeconds: 6,
  emoteSize: 150,
  emoteExcludeZones: [],
  greetingDisplaySeconds: 6,
  greetingVolume: 70,
  greetingFontFamily: "Arial",
  greetingFontSize: 36,
  greetingBold: true,
  greetingTextColor: "#FFFFFF",
  greetingOutlineColor: "#000000",
  greetingOutlineWidth: 2,
  greetingShadow: true,
  greetingEmoteSize: 300,
  greetingTemplate: "{user}",
  greetingAnimations: ["none"],
  gameElementX: 60,
  gameElementY: 900,
  gameElementScale: 100,
  gameElementTemplate: "{game}\n{time}",
  gameShowBoxArt: true,
  gameShowPaused: true,
  gameHideWhenNoGame: true,
  gameIdleMinutes: 5,
  gameFontFamily: "Arial",
  gameFontSize: 36,
  gameBold: true,
  gameTextColor: "#FFFFFF",
  gameOutlineColor: "#000000",
  gameOutlineWidth: 2,
  gameShadow: true,
  editEnabled: false,
  obsHost: "127.0.0.1",
  obsPort: 4455,
  obsPassword: "",
  editSources: [],
  editAudioSource: "",
  editCommand: "!edit",
  editDuration: 30,
  editCooldown: 120,
  editWho: ["broadcaster", "moderator", "vip"],
  editIntensity: 100,
  editEffects: ["punch", "smash", "shake", "tilt", "zoomspin", "spin", "flip", "glitch", "flash", "strobe", "flicker", "hue", "tint", "mono", "crunch", "invert", "xerox", "poster", "sepia", "duotone", "thermal", "nightvision"],
  editLatencyMs: 60,
  editAlwaysPunch: true,
  editBoxPulse: true,
  editBoxPulseAmount: 12,
  moduleEmotes: true,
  moduleGreetings: true,
  moduleGame: false,
  editRewardEnabled: false,
  editRewardTitle: "Эдит на вебке",
  editRewardCost: 5000,
  editRewardDuration: 30,
  editRewardBoost: 25
};

// Загрузка из bot-config.json если существует
const CONFIG_FILE = path.join(__dirname, "bot-config.json");
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config = { ...config, ...fileConfig };
    console.log("[CONFIG] Loaded from bot-config.json");
  } catch (err) {
    console.error("[CONFIG] Failed to parse bot-config.json:", err);
  }
}

function loadCachedEmoteNames() {
  if (!fs.existsSync(EMOTE_NAMES_FILE)) return;

  try {
    const raw = fs.readFileSync(EMOTE_NAMES_FILE, "utf8");
    const data = JSON.parse(raw);

    let loaded = 0;
    for (const [code, info] of Object.entries(data || {})) {
      if (!code) continue;

      if (info && typeof info === "object" && info.id) {
        const entry = { id: String(info.id), format: String(info.format || "png") };
        if (info.source) entry.source = String(info.source);
        emoteNames.set(code, entry);
        loaded++;
      } else if (typeof info === "string") {
        emoteNames.set(code, { id: info, format: "png" });
        loaded++;
      }
    }

    if (loaded > 0) {
      console.log(`[CACHE] Loaded ${loaded} cached emote names`);
    }
  } catch (err) {
    console.error("[CACHE] Failed to load cached emote names:", err.message);
  }
}

// Переопределение из переменной окружения CONFIG (для web-server.js)
if (process.env.CONFIG) {
  try {
    config = { ...config, ...JSON.parse(process.env.CONFIG) };
    console.log("[CONFIG] Loaded from environment");
  } catch (err) {
    console.error("[CONFIG] Failed to parse:", err);
  }
}

// Валидация обязательных полей
if (!config.twitchClientId || !config.twitchClientSecret) {
  console.error("[CONFIG] ERROR: Twitch credentials not configured!");
  console.error("[CONFIG] Please set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET");
  console.error("[CONFIG] or configure them in bot-config.json");
}

const CHANNEL = config.channel;
// Модули: выключенный ничего не загружает и не работает в фоне (эдит включается своим editEnabled — на лету)
const MODULES = {
  emotes: config.moduleEmotes !== false,
  greetings: config.moduleGreetings !== false,
  game: config.moduleGame === true,
};
const onOff = (on) => (on ? "on" : "off");
const TWITCH_CLIENT_ID = config.twitchClientId;
const TWITCH_CLIENT_SECRET = config.twitchClientSecret;
const PORT = config.port;
const GREETING_KEYWORDS = (Array.isArray(config.greetingKeywords) ? config.greetingKeywords : [])
  .map(keyword => String(keyword).toLowerCase());
const GREETING_EMOTE_CODES = Array.isArray(config.greetingEmotes) ? config.greetingEmotes : [];
const EMOTE_BLACKLIST = new Set((config.emoteBlacklist || []).map(String));
const EMOTE_SPAM_LIMIT = config.emoteSpamLimit;
const EMOTE_SPAM_WINDOW_MS = config.emoteSpamWindow * 1000;
const EMOTE_BOOST_ON_SAME_FROM_DIFFERENT_USER = config.emoteBoostOnSameFromDifferentUser !== false;
const EMOTE_BOOST_SCALE_STEP = Math.max(0, Number(config.emoteBoostScalePercent ?? 20)) / 100;
const GREETING_EXPIRE_MS = config.greetingExpireDays * 24 * 60 * 60 * 1000;
const OLD_FILES_EXPIRE_MS = config.oldFilesExpireDays * 24 * 60 * 60 * 1000;

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const EMOTE_DISPLAY_MS = Math.round(clampNum(config.emoteDisplaySeconds, 1, 120, 6) * 1000);
const EMOTE_SIZE = Math.round(clampNum(config.emoteSize, 24, 600, 150));
// Зоны без эмоутов (рисуются в панели поверх предпросмотра) — уходят оверлею в каждом событии эмоута
const EMOTE_ZONES = Array.isArray(config.emoteExcludeZones) ? config.emoteExcludeZones : [];
const GREETING_DISPLAY_MS = Math.round(clampNum(config.greetingDisplaySeconds, 1, 120, 6) * 1000);
const GREETING_VOLUME = clampNum(config.greetingVolume, 0, 100, 70) / 100;
// Оформление приветствия уходит в оверлей вместе с каждым приветствием
const GREETING_STYLE = {
  fontFamily: config.greetingFontFamily || "Arial",
  fontSize: clampNum(config.greetingFontSize, 12, 120, 36),
  bold: config.greetingBold !== false,
  color: config.greetingTextColor || "#FFFFFF",
  outlineColor: config.greetingOutlineColor || "#000000",
  outlineWidth: clampNum(config.greetingOutlineWidth, 0, 10, 2),
  shadow: config.greetingShadow !== false,
  emoteSize: clampNum(config.greetingEmoteSize, 40, 340, 300),
  template: config.greetingTemplate || "{user}",
  // из выбранных оверлей каждый раз берёт случайную; старый конфиг хранил одну строку greetingAnimation
  animations: Array.isArray(config.greetingAnimations)
    ? config.greetingAnimations
    : [config.greetingAnimation || "none"],
};

// Элемент «Текущая игра»: оформление уходит в оверлей с каждым событием и меняется без перезапуска (/api/game/overlay)
function buildGameStyle(c) {
  return {
    x: Math.round(clampNum(c.gameElementX, 0, 1920, 60)),
    y: Math.round(clampNum(c.gameElementY, 0, 1080, 900)),
    scale: clampNum(c.gameElementScale, 10, 400, 100),
    template: typeof c.gameElementTemplate === "string" && c.gameElementTemplate.trim() ? c.gameElementTemplate : "{game}\n{time}",
    showBoxArt: c.gameShowBoxArt !== false,
    showPaused: c.gameShowPaused !== false,
    hideWhenNoGame: c.gameHideWhenNoGame !== false,
    fontFamily: c.gameFontFamily || "Arial",
    fontSize: clampNum(c.gameFontSize, 12, 120, 36),
    bold: c.gameBold !== false,
    color: c.gameTextColor || "#FFFFFF",
    outlineColor: c.gameOutlineColor || "#000000",
    outlineWidth: clampNum(c.gameOutlineWidth, 0, 10, 2),
    shadow: c.gameShadow !== false,
  };
}
let GAME_STYLE = buildGameStyle(config);
let GAME_IDLE_MS = clampNum(config.gameIdleMinutes, 1, 60, 5) * 60 * 1000;

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  if (!["/api/game/state", "/api/edit/state", "/api/reward/state"].includes(req.url)) console.log(`[HTTP] ${req.method} ${req.url}`); // панель опрашивает их постоянно
  next();
});

// страницы оверлеев — без кэша: OBS должен брать свежие после обновления бота
app.use(express.static(path.join(__dirname, "overlay"), {
  setHeaders: (res, file) => { if (/\.(html|js)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));
app.use("/sounds", express.static(path.join(__dirname, "sounds")));
app.use("/cache", express.static(path.join(__dirname, "cache")));

app.get("/special-sound/:id", (req, res) => {
  const sound = specialSoundStore.get(req.params.id);
  if (!sound) {
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", sound.mime);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(sound.buffer);
});

app.post("/api/session/reset", (req, res) => {
  const greetedCount = greetedUsers.size;
  const spamUsersCount = userEmoteTimestamps.size;
  const streamIdBeforeReset = currentStreamId;

  greetedUsers.clear();
  userEmoteTimestamps.clear();

  if (saveGreetingsTimeout) {
    clearTimeout(saveGreetingsTimeout);
    saveGreetingsTimeout = null;
  }

  if (streamIdBeforeReset) {
    try {
      const filePath = getGreetingFilePath(streamIdBeforeReset);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error(`[SESSION] Failed to remove greeting file for stream ${streamIdBeforeReset}:`, err.message);
    }
  }

  console.log(`[SESSION] Reset current session (greetings: ${greetedCount}, spam users: ${spamUsersCount})`);
  res.json({ success: true, greetedCount, spamUsersCount, streamId: streamIdBeforeReset });
});

app.post("/api/sounds/reload", (req, res) => {
  loadSoundFiles();
  res.json({ success: true, count: soundFiles.length, special: specialGreetingSoundFiles.length });
});

// Время в играх: текущее состояние и список для панели
app.get("/api/game/state", (req, res) => {
  const games = Object.entries(playtime)
    .map(([id, g]) => ({ id, name: g.name, boxArt: g.boxArt || null, seconds: Math.floor(g.seconds || 0), lastPlayed: g.lastPlayed || null }))
    .sort((a, b) => String(b.lastPlayed || "").localeCompare(String(a.lastPlayed || "")));
  const { type, ...current } = gameStatePayload();
  res.json({ success: true, current, games, idleMonitor: idleMonitor.available(), idleMs: idleMonitor.getIdleMs() });
});

// Ручная правка времени (секунды; 0 — сброс)
app.post("/api/game/playtime/:id", (req, res) => {
  const entry = playtime[req.params.id];
  const seconds = Number(req.body?.seconds);
  if (!entry) {
    res.status(404).json({ success: false, error: "Игра не найдена" });
    return;
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    res.status(400).json({ success: false, error: "Неверное время" });
    return;
  }
  entry.seconds = Math.floor(seconds);
  console.log(`[GAME] Time for "${entry.name}" set to ${formatGameTime(entry.seconds)}`);
  savePlaytime();
  broadcastGameState();
  res.json({ success: true, seconds: entry.seconds });
});

// Новые настройки элемента «Текущая игра» без перезапуска бота (присылает web-server.js при сохранении)
app.post("/api/game/overlay", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("game")) config[key] = value;
  }
  GAME_STYLE = buildGameStyle(config);
  GAME_IDLE_MS = clampNum(config.gameIdleMinutes, 1, 60, 5) * 60 * 1000;
  console.log("[GAME] Overlay settings updated");
  broadcastGameState();
  res.json({ success: true });
});

app.get("/api/edit/state", (req, res) => {
  res.json({ success: true, ...edit.state() });
});

app.get("/api/edit/sources", async (req, res) => {
  try {
    res.json({ success: true, ...(await edit.sources()) });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.post("/api/edit/start", async (req, res) => {
  try {
    const duration = Number(req.body?.duration) || undefined;
    res.json({ success: true, ...(await edit.start({ by: "панель", duration, force: true })) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/edit/stop", async (req, res) => {
  res.json({ success: true, ...(await edit.stop("остановлен из панели")) });
});

// Новые настройки эдита без перезапуска бота (присылает web-server.js при сохранении)
app.post("/api/edit/config", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("edit") || key.startsWith("obs")) config[key] = value;
  }
  edit.applyConfig(config);
  rewards.applyConfig(config);
  console.log("[EDIT] Settings updated");
  res.json({ success: true });
});

// Награда за баллы: вход в Twitch и состояние награды (twitch-rewards.js)
app.get("/api/reward/state", (req, res) => {
  res.json({ success: true, ...rewards.state() });
});

app.post("/api/reward/login", async (req, res) => {
  try {
    res.json({ success: true, ...(await rewards.startLogin()) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/reward/logout", async (req, res) => {
  rewards.cancelLogin();
  await rewards.logout();
  res.json({ success: true, ...rewards.state() });
});

app.post("/api/shutdown", async (req, res) => {
  console.log("[PROCESS] Shutdown requested via API");
  await Promise.all([edit.shutdown(), rewards.shutdown()]); // вернуть вебку на место, спрятать награду
  savePlaytime();
  if (saveGreetingsTimeout) {
    clearTimeout(saveGreetingsTimeout);
    saveGreetingsTimeout = null;
  }
  if (currentStreamId) {
    saveGreetingsToFile(currentStreamId);
  }
  res.json({ success: true });
  setTimeout(() => process.exit(0), 100);
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Overlays http://127.0.0.1:${PORT}`);
  console.log(`  Greeting: http://127.0.0.1:${PORT}/greeting.html`);
  console.log(`  Emotes:   http://127.0.0.1:${PORT}/emotes.html`);
  console.log(`  Game:     http://127.0.0.1:${PORT}/game.html`);
});

const wssGreeting = new WebSocket.Server({ noServer: true });
const wssEmotes = new WebSocket.Server({ noServer: true });
const wssGame = new WebSocket.Server({ noServer: true });

// ---- «Эдит» на вебке (edit.js): эффекты на источник камеры в OBS под бит
const { EditController } = require("./edit");
const edit = new EditController({
  dataDir: path.join(__dirname, "cache"),
  log: (msg) => console.log(msg),
});
edit.applyConfig(config);

// Награда за баллы канала: запускает эдит, повторная — продлевает и усиливает его.
// Не получилось (OBS не подключён и т.п.) — баллы возвращаются
const { RewardManager } = require("./twitch-rewards");
const rewards = new RewardManager({
  file: path.join(__dirname, "twitch-auth.json"),
  log: (msg) => console.log(msg),
  isAvailable: () => {
    const s = edit.state();
    return s.enabled && s.obs.connected && edit.cfg.sources.length > 0;
  },
});
rewards.applyConfig(config);
rewards.on("redemption", async (r) => {
  const duration = Math.min(600, Math.max(5, Number(config.editRewardDuration) || 30));
  const boost = Math.min(100, Math.max(0, Number(config.editRewardBoost ?? 25))) / 100;
  try {
    const result = await edit.start({ by: `${r.user} (за баллы)`, duration, force: true, stack: true, boost });
    if (result.started) console.log(`[REWARD] ${r.user} redeemed the edit`);
    await rewards.resolve(r, true);
  } catch (err) {
    console.log(`[REWARD] ${r.user}: ${err.message} — points refunded`);
    await rewards.resolve(r, false);
  }
});

// Кто может запускать эдит командой: editWho = ["broadcaster", "moderator", "vip", "subscriber", "everyone"]
function canTriggerEdit(tags) {
  const who = new Set(Array.isArray(config.editWho) ? config.editWho : []);
  const badges = tags.badges || {};
  return who.has("everyone") ||
    (who.has("broadcaster") && Boolean(badges.broadcaster)) ||
    (who.has("moderator") && (tags.mod === true || Boolean(badges.moderator) || Boolean(badges.broadcaster))) ||
    (who.has("vip") && (Boolean(badges.vip) || tags.vip === true)) ||
    (who.has("subscriber") && (tags.subscriber === true || Boolean(badges.subscriber) || Boolean(badges.founder)));
}

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/ws/greeting') {
    wssGreeting.handleUpgrade(request, socket, head, (ws) => {
      wssGreeting.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/emotes') {
    wssEmotes.handleUpgrade(request, socket, head, (ws) => {
      wssEmotes.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/game') {
    wssGame.handleUpgrade(request, socket, head, (ws) => {
      wssGame.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

function broadcastGreeting(data) {
  const payload = JSON.stringify(data);
  for (const client of wssGreeting.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastEmotes(data) {
  const payload = JSON.stringify(data);
  for (const client of wssEmotes.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Версия файлов оверлеев. Оверлей получает её при подключении и, если она сменилась (бота обновили или поменяли
// оверлей), перезагружается сам — иначе «Браузер» в OBS так и работал бы со старой страницей до ручного обновления
const OVERLAY_VERSION = (() => {
  const dir = path.join(__dirname, "overlay");
  const hash = require("crypto").createHash("sha1");
  for (const name of fs.readdirSync(dir).sort()) {
    const st = fs.statSync(path.join(dir, name));
    hash.update(`${name}:${st.size}:${st.mtimeMs}`);
  }
  return hash.digest("hex").slice(0, 12);
})();
const sendHello = (ws) => ws.send(JSON.stringify({ type: "hello", version: OVERLAY_VERSION }));

wssGreeting.on("connection", (ws) => {
  console.log("[WS] Greeting overlay connected");
  sendHello(ws);
});

wssEmotes.on("connection", (ws) => {
  console.log("[WS] Emotes overlay connected");
  sendHello(ws);
});

wssGame.on("connection", (ws) => {
  console.log("[WS] Game overlay connected");
  sendHello(ws);
  ws.send(JSON.stringify(gameStatePayload()));
});

setInterval(() => {
  const payload = JSON.stringify({ type: "ping", ts: Date.now() });

  for (const client of wssGreeting.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  for (const client of wssEmotes.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  for (const client of wssGame.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

}, 5000);

// ---- «Текущая игра»: категория стрима + общее время в каждой игре (пауза, если нет ввода дольше GAME_IDLE_MS)

const GAMES_DIR = path.join(__dirname, "games");
const PLAYTIME_FILE = path.join(GAMES_DIR, "playtime.json");
// монитор бездействия (отдельный процесс) нужен только «Текущей игре»
const idleMonitor = MODULES.game ? startIdleMonitor() : { getIdleMs: () => null, available: () => false };

let playtime = {};        // game_id Twitch -> { name, boxArt, seconds, lastPlayed }
let currentGame = null;   // { id, name } — категория идущего стрима
let gameRunning = false;  // идёт ли сейчас счёт
let lastGameTickTs = Date.now();
let savePlaytimeTimeout = null;

function loadPlaytime() {
  try {
    if (fs.existsSync(PLAYTIME_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLAYTIME_FILE, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) playtime = data;
      console.log(`[GAME] Loaded playtime for ${Object.keys(playtime).length} game(s)`);
    }
  } catch (err) {
    console.error("[GAME] Failed to load playtime:", err.message);
  }
}

function savePlaytime() {
  if (savePlaytimeTimeout) {
    clearTimeout(savePlaytimeTimeout);
    savePlaytimeTimeout = null;
  }
  try {
    if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
    fs.writeFileSync(PLAYTIME_FILE, JSON.stringify(playtime, null, 2), "utf8");
  } catch (err) {
    console.error("[GAME] Failed to save playtime:", err.message);
  }
}

function debouncedSavePlaytime() {
  if (savePlaytimeTimeout) return;
  savePlaytimeTimeout = setTimeout(savePlaytime, 30 * 1000);
}

function formatGameTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function gameStatePayload() {
  const entry = currentGame && playtime[currentGame.id];
  return {
    type: "game",
    game: currentGame ? { id: currentGame.id, name: currentGame.name, boxArt: entry?.boxArt || null } : null,
    seconds: entry ? Math.floor(entry.seconds) : 0,
    running: gameRunning,
    style: GAME_STYLE,
  };
}

function broadcastGameState() {
  const payload = JSON.stringify(gameStatePayload());
  for (const client of wssGame.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function fetchBoxArt(gameId, appAccessToken) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/games?id=${encodeURIComponent(gameId)}`, {
      headers: { "Client-Id": TWITCH_CLIENT_ID, "Authorization": `Bearer ${appAccessToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const url = data.data && data.data[0] && data.data[0].box_art_url;
    if (url && playtime[gameId]) {
      playtime[gameId].boxArt = url; // шаблон с {width}x{height}
      debouncedSavePlaytime();
      if (currentGame && currentGame.id === gameId) broadcastGameState();
    }
  } catch (err) {
    console.error("[GAME] Failed to load box art:", err.message);
  }
}

// streamInfo — ответ helix/streams (null, если стрим не идёт)
function updateCurrentGame(streamInfo, appAccessToken) {
  const next = streamInfo && streamInfo.game_id ? { id: String(streamInfo.game_id), name: streamInfo.game_name || "" } : null;
  if (!next && !currentGame) return;
  if (next && currentGame && next.id === currentGame.id) {
    currentGame.name = next.name;
    return;
  }

  currentGame = next;
  if (next) {
    let entry = playtime[next.id];
    if (!entry) {
      entry = playtime[next.id] = { name: next.name, boxArt: null, seconds: 0, lastPlayed: null };
      debouncedSavePlaytime();
    }
    entry.name = next.name;
    console.log(`[GAME] Category: ${next.name} (total ${formatGameTime(entry.seconds)})`);
    if (!entry.boxArt) fetchBoxArt(next.id, appAccessToken);
  } else {
    console.log("[GAME] No category (stream offline)");
    savePlaytime();
  }
  gameTick();
  broadcastGameState();
}

function gameTick() {
  const now = Date.now();
  const elapsed = Math.min(5000, Math.max(0, now - lastGameTickTs)); // после сна компьютера не накручиваем часы
  lastGameTickTs = now;

  const idleMs = idleMonitor.getIdleMs(); // null — детектор недоступен, считаем, что игрок за компьютером
  const idle = idleMs !== null && idleMs >= GAME_IDLE_MS;
  const entry = currentGame && playtime[currentGame.id];
  const running = !!entry && !idle;

  if (running && gameRunning) {
    entry.seconds = (entry.seconds || 0) + elapsed / 1000;
    entry.lastPlayed = new Date(now).toISOString();
    debouncedSavePlaytime();
  }

  if (running !== gameRunning) {
    gameRunning = running;
    if (entry) console.log(running ? `[GAME] Timer resumed: ${entry.name}` : `[GAME] Paused (idle ${Math.round(idleMs / 60000)} min)`);
    broadcastGameState();
  }
}

if (MODULES.game) {
  loadPlaytime();
  setInterval(gameTick, 1000);
  setInterval(broadcastGameState, 15 * 1000); // оверлей тикает сам, это — сверка
}

const emoteMap = new Map();
const emoteNames = new Map(); // Map<code, id> для сохранения соответствий
const greetedUsers = new Map();
const soundFiles = [];
const specialGreetingSoundFiles = [];
const specialSoundStore = new Map();
const userEmoteTimestamps = new Map();

let currentStreamId = null;
let currentStreamStartedAt = null;

const GREETINGS_DIR = path.join(__dirname, "greetings");
const CACHE_DIR = path.join(__dirname, "cache");
const EMOTES_CACHE_DIR = path.join(CACHE_DIR, "emotes");
const EMOTE_NAMES_FILE = path.join(CACHE_DIR, "emote_names.json");
const SPECIAL_GREETING_USER = "soseeskes";
const SPECIAL_SOUNDS_PACK_FILE = path.join(__dirname, "special-sounds-packed.json");

function getSoundMimeByExt(ext) {
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

function loadPackedSpecialSounds() {
  specialGreetingSoundFiles.length = 0;
  specialSoundStore.clear();

  try {
    if (!fs.existsSync(SPECIAL_SOUNDS_PACK_FILE)) {
      console.log("[SOUNDS] special-sounds-packed.json not found");
      return;
    }

    const raw = JSON.parse(fs.readFileSync(SPECIAL_SOUNDS_PACK_FILE, "utf8"));
    const list = Array.isArray(raw?.sounds) ? raw.sounds : [];

    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const id = String(item.id || `special_${i + 1}`);
      const ext = String(item.ext || "").toLowerCase();
      const base64 = String(item.data || "");

      if (![".mp3", ".ogg", ".wav"].includes(ext)) continue;
      if (!base64) continue;

      let buffer;
      try {
        buffer = Buffer.from(base64, "base64");
      } catch {
        continue;
      }

      if (!buffer || buffer.length === 0) continue;

      const mime = item.mime || getSoundMimeByExt(ext);
      specialSoundStore.set(id, { buffer, mime, ext, name: item.name || id });
      specialGreetingSoundFiles.push(`special-sound/${id}`);
    }
  } catch (err) {
    console.error("[SOUNDS] Failed to read special-sounds-packed.json:", err.message);
  }
}

function loadSoundFiles() {
  const soundsDir = path.join(__dirname, "sounds");
  soundFiles.length = 0; // функцию вызывают и повторно — из панели («Обновить» в списке звуков)

  if (fs.existsSync(soundsDir)) {
    function scanDir(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(item).toLowerCase();
          if ([".ogg", ".mp3", ".wav"].includes(ext)) {
            const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, "/");
            soundFiles.push(relativePath);
          }
        }
      }
    }
    scanDir(soundsDir);
  } else {
    console.log("[SOUNDS] sounds directory not found");
  }

  loadPackedSpecialSounds();

  console.log(`[SOUNDS] Loaded ${soundFiles.length} sound files`);
  console.log(`[SOUNDS] Special greeting sounds: ${specialGreetingSoundFiles.length}`);
}

function getRandomSound() {
  if (soundFiles.length === 0) return null;
  return soundFiles[Math.floor(Math.random() * soundFiles.length)];
}

function getRandomFromList(files) {
  if (!files || files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

function getGreetingSoundForUser(username) {
  const lowerUser = String(username || "").toLowerCase();

  if (lowerUser === SPECIAL_GREETING_USER.toLowerCase()) {
    return getRandomFromList(specialGreetingSoundFiles);
  }

  return getRandomSound();
}

function ensureGreetingsDir() {
  if (!fs.existsSync(GREETINGS_DIR)) {
    fs.mkdirSync(GREETINGS_DIR, { recursive: true });
    console.log(`[GREETINGS] Created directory: ${GREETINGS_DIR}`);
  }
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!fs.existsSync(EMOTES_CACHE_DIR)) {
    fs.mkdirSync(EMOTES_CACHE_DIR, { recursive: true });
    console.log(`[CACHE] Created emotes cache directory`);
  }
}

function getEmoteCachePath(emoteId, format = "png") {
  return path.join(EMOTES_CACHE_DIR, `${emoteId}.${format}`);
}

function isEmoteCached(emoteId, format = "png") {
  return fs.existsSync(getEmoteCachePath(emoteId, format));
}

function isGifFileValid(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(6);
    fs.readSync(fd, header, 0, 6, 0);
    fs.closeSync(fd);
    const magic = header.toString("ascii");
    return magic === "GIF89a" || magic === "GIF87a";
  } catch {
    return false;
  }
}

// Проверяем есть ли эмоут в любом формате
function isEmoteCachedAnyFormat(emoteId) {
  const formats = ["png", "gif", "webp"];
  for (const fmt of formats) {
    if (fs.existsSync(getEmoteCachePath(emoteId, fmt))) {
      return fmt;
    }
  }
  return null;
}

function removeCachedEmoteFormat(emoteId, format) {
  const cachePath = getEmoteCachePath(emoteId, format);
  if (!fs.existsSync(cachePath)) return false;

  try {
    fs.unlinkSync(cachePath);
    return true;
  } catch (err) {
    console.error(`[CACHE] Failed to remove ${format} cache for ${emoteId}:`, err.message);
    return false;
  }
}

function isBlacklistedEmote(code) {
  if (!code) return false;
  return EMOTE_BLACKLIST.has(String(code));
}

async function downloadEmoteToCache(emoteId, url, format = "png") {
  // Проверяем кэш только в запрошенном формате
  if (isEmoteCached(emoteId, format)) {
    if (format === "gif") {
      const cachePath = getEmoteCachePath(emoteId, format);
      if (!isGifFileValid(cachePath)) {
        try {
          fs.unlinkSync(cachePath);
          console.log(`[CACHE] Removed invalid gif cache for ${emoteId}`);
        } catch (err) {
          console.error(`[CACHE] Failed to remove invalid gif cache for ${emoteId}:`, err.message);
        }
      } else {
        return getEmoteCachePath(emoteId, format);
      }
    } else {
      return getEmoteCachePath(emoteId, format);
    }
  }

  const cachePath = getEmoteCachePath(emoteId, format);

  try {
    // Таймаут 10 секунд для скачивания
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(cachePath, Buffer.from(buffer));

    return cachePath;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[CACHE] Timeout downloading emote ${emoteId}`);
    } else {
      console.error(`[CACHE] Failed to download emote ${emoteId}:`, err.message);
    }
    return null;
  }

}

function getCachedEmoteUrl(emoteId, format = "png") {
  // Проверяем все возможные форматы
  const formats = [format, "png", "gif", "webp"];

  for (const fmt of formats) {
    if (isEmoteCached(emoteId, fmt)) {
      return `/cache/emotes/${emoteId}.${fmt}`;
    }
  }

  return null;
}

function getGreetingFilePath(streamId) {
  return path.join(GREETINGS_DIR, `stream_${streamId}.json`);
}

function loadGreetingsFromFile(streamId) {
  const filePath = getGreetingFilePath(streamId);

  if (!fs.existsSync(filePath)) {
    console.log(`[GREETINGS] No file for stream ${streamId}`);
    return;
  }

  try {
    const data = fs.readFileSync(filePath, "utf8");
    const greetings = JSON.parse(data);

    for (const [username, timestamp] of Object.entries(greetings)) {
      greetedUsers.set(username.toLowerCase(), timestamp);
    }

    console.log(`[GREETINGS] Loaded ${Object.keys(greetings).length} greetings from stream ${streamId}`);
  } catch (err) {
    console.error(`[GREETINGS] Failed to load file for stream ${streamId}:`, err);
  }
}

function saveGreetingsToFile(streamId) {
  if (!streamId) return;

  ensureGreetingsDir();
  const filePath = getGreetingFilePath(streamId);

  const greetings = {};
  for (const [username, timestamp] of greetedUsers.entries()) {
    greetings[username] = timestamp;
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(greetings, null, 2), "utf8");
    console.log(`[GREETINGS] Saved ${Object.keys(greetings).length} greetings to stream ${streamId}`);
  } catch (err) {
    console.error(`[GREETINGS] Failed to save file for stream ${streamId}:`, err);
  }
}

function cleanupOldGreetingFiles() {
  if (!fs.existsSync(GREETINGS_DIR)) return;

  const now = Date.now();
  const files = fs.readdirSync(GREETINGS_DIR);
  let removed = 0;

  for (const file of files) {
    if (!file.startsWith("stream_") || !file.endsWith(".json")) continue;

    const filePath = path.join(GREETINGS_DIR, file);
    const stats = fs.statSync(filePath);
    const age = now - stats.mtime.getTime();

    if (age > OLD_FILES_EXPIRE_MS) {
      fs.unlinkSync(filePath);
      removed++;
      console.log(`[GREETINGS] Removed old file: ${file} (${Math.floor(age / (24 * 60 * 60 * 1000))} days old)`);
    }
  }

  if (removed > 0) {
    console.log(`[GREETINGS] Cleaned up ${removed} old greeting file(s)`);
  } else {
    console.log(`[GREETINGS] No old files to clean up`);
  }
}

// Параллельная загрузка с ограничением одновременных запросов
async function downloadEmotesParallel(emotesList, concurrency = 10) {
  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  const total = emotesList.length;

  // Разбиваем на батчи
  for (let i = 0; i < emotesList.length; i += concurrency) {
    const batch = emotesList.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async (emote) => {
        const exactFormatCached = isEmoteCached(emote.id, emote.format);
        if (exactFormatCached) {
          if (emote.format === "gif") {
            const cachePath = getEmoteCachePath(emote.id, emote.format);
            if (!isGifFileValid(cachePath)) {
              try {
                fs.unlinkSync(cachePath);
                console.log(`[CACHE] Removed invalid gif cache for ${emote.id} before reload`);
              } catch (err) {
                console.error(`[CACHE] Failed to remove invalid gif cache for ${emote.id}:`, err.message);
              }
            } else {
              return { status: 'cached', emote, format: emote.format };
            }
          } else {
            return { status: 'cached', emote, format: emote.format };
          }
        }

        const result = await downloadEmoteToCache(emote.id, emote.url, emote.format);
        if (result) {
          return { status: 'downloaded', emote };
        }
        return { status: 'failed', emote };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.status === 'cached') cached++;
        else if (result.value.status === 'downloaded') downloaded++;
        else failed++;
      } else {
        failed++;
      }
    }

    // Логируем прогресс каждые 50 загрузок
    const processed = Math.min(i + concurrency, total);
    if (downloaded > 0 && downloaded % 50 < concurrency) {
      console.log(`[CACHE] Progress: ${processed}/${total} (downloaded: ${downloaded}, cached: ${cached})`);
    }
  }

  return { downloaded, cached, failed };
}

async function getRecentStreams(channelId, appAccessToken, count = 3) {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${channelId}&type=archive&first=${count}`,
      {
        headers: {
          "Client-Id": TWITCH_CLIENT_ID,
          "Authorization": `Bearer ${appAccessToken}`,
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Get Videos error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return data.data || [];
  } catch (err) {
    console.error("[STREAMS] Failed to get recent streams:", err);
    return [];
  }
}

async function isTwitchAnimatedAvailable(emoteId) {
  const animatedUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/animated/dark/3.0`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(animatedUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return false;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 6) return false;

    const magic = buffer.slice(0, 6).toString("ascii");
    return magic === "GIF89a" || magic === "GIF87a";
  } catch {
    return false;
  }
}

async function buildTwitchEmotesList(emotes, concurrency = 20) {
  const result = [];

  for (let i = 0; i < emotes.length; i += concurrency) {
    const batch = emotes.slice(i, i + concurrency);

    const batchResult = await Promise.all(
      batch.map(async (emote) => {
        let isAnimated = emote.format.includes("animated");

        if (!isAnimated) {
          isAnimated = await isTwitchAnimatedAvailable(emote.id);
        }

        return {
          id: emote.id,
          name: emote.name,
          isAnimated,
          format: isAnimated ? "gif" : "png",
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/${isAnimated ? "animated" : "static"}/dark/3.0`
        };
      })
    );

    result.push(...batchResult);
  }

  return result;
}

async function loadTwitchGlobalEmotes(appAccessToken) {
  try {
    const res = await fetch("https://api.twitch.tv/helix/chat/emotes/global", {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${appAccessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Twitch global emotes error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const emotes = data.data || [];

    // Подготавливаем список для параллельной загрузки
    const emotesList = await buildTwitchEmotesList(emotes, 20);

    let removedStaticCount = 0;
    for (const emote of emotesList) {
      if (emote.isAnimated && removeCachedEmoteFormat(emote.id, "png")) {
        removedStaticCount++;
      }
    }

    // Загружаем параллельно
    const { downloaded, cached } = await downloadEmotesParallel(emotesList, 15);

    // Добавляем эмоуты в карту
    for (const emote of emotesList) {
      let selectedFormat = emote.format;
      let localUrl = getCachedEmoteUrl(emote.id, selectedFormat);
      if (!localUrl) {
        const existingFormat = isEmoteCachedAnyFormat(emote.id);
        if (existingFormat) {
          selectedFormat = existingFormat;
          localUrl = getCachedEmoteUrl(emote.id, selectedFormat);
        }
      }
      if (localUrl) {
        addEmote(emote.name, localUrl, "Twitch global", emote.id, selectedFormat);
      }
    }

    console.log(`[EMOTES] Twitch global loaded: ${emotes.length} (cached: ${cached}, downloaded: ${downloaded}, removed static: ${removedStaticCount})`);
  } catch (err) {
    console.error("[EMOTES] Failed to load Twitch global emotes:", err);
  }
}

async function loadTwitchChannelEmotes(channelId, appAccessToken) {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${channelId}`, {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${appAccessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Twitch channel emotes error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const emotes = data.data || [];

    const emotesList = await buildTwitchEmotesList(emotes, 20);

    let removedStaticCount = 0;
    for (const emote of emotesList) {
      if (emote.isAnimated && removeCachedEmoteFormat(emote.id, "png")) {
        removedStaticCount++;
      }
    }

    const { downloaded, cached } = await downloadEmotesParallel(emotesList, 15);

    for (const emote of emotesList) {
      let selectedFormat = emote.format;
      let localUrl = getCachedEmoteUrl(emote.id, selectedFormat);
      if (!localUrl) {
        const existingFormat = isEmoteCachedAnyFormat(emote.id);
        if (existingFormat) {
          selectedFormat = existingFormat;
          localUrl = getCachedEmoteUrl(emote.id, selectedFormat);
        }
      }
      if (localUrl) {
        addEmote(emote.name, localUrl, "Twitch channel", emote.id, selectedFormat);
      }
    }

    console.log(`[EMOTES] Twitch channel loaded: ${emotes.length} (cached: ${cached}, downloaded: ${downloaded}, removed static: ${removedStaticCount})`);
  } catch (err) {
    console.error("[EMOTES] Failed to load Twitch channel emotes:", err);
  }
}

async function getStreamInfo(channelId, appAccessToken) {
  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_id=${channelId}`,
    {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${appAccessToken}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Get Stream error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.data.length > 0 ? data.data[0] : null;
}

// Опрос идёт каждые 30 с — токен и id канала не запрашиваем каждый раз заново
let streamPollAuth = null; // { token, expiresAt, userId }

async function getStreamPollAuth() {
  if (streamPollAuth && Date.now() < streamPollAuth.expiresAt) return streamPollAuth;
  const tokenData = await getTwitchAppToken();
  const user = await getTwitchUserByLogin(CHANNEL, tokenData.access_token);
  const ttlMs = Math.max(60, Number(tokenData.expires_in) || 3600) * 1000;
  streamPollAuth = { token: tokenData.access_token, expiresAt: Date.now() + ttlMs - 5 * 60 * 1000, userId: user.id };
  return streamPollAuth;
}

async function updateStreamInfo() {
  try {
    const auth = await getStreamPollAuth();
    const appAccessToken = auth.token;
    let streamInfo;
    try {
      streamInfo = await getStreamInfo(auth.userId, appAccessToken);
    } catch (err) {
      streamPollAuth = null; // токен могли отозвать — в следующий раз возьмём новый
      throw err;
    }

    if (MODULES.game) updateCurrentGame(streamInfo, appAccessToken);

    if (streamInfo) {
      const newStreamId = streamInfo.id;

      if (currentStreamId !== newStreamId) {
        console.log(`[STREAM] New stream detected! ID: ${newStreamId}`);
        console.log(`[STREAM] Started at: ${streamInfo.started_at}`);
        console.log(`[STREAM] Title: ${streamInfo.title}`);
        console.log(`[STREAM] Game: ${streamInfo.game_name}`);

        if (currentStreamId) {
          saveGreetingsToFile(currentStreamId);
        }

        currentStreamId = newStreamId;
        currentStreamStartedAt = new Date(streamInfo.started_at);

        greetedUsers.clear();
        loadGreetingsFromFile(newStreamId);

        console.log(`[GREET] Ready for new stream (loaded ${greetedUsers.size} previous greetings)`);
      }
    } else {
      if (currentStreamId) {
        console.log(`[STREAM] Stream ended`);
        saveGreetingsToFile(currentStreamId);
        currentStreamId = null;
        currentStreamStartedAt = null;
      }
    }
  } catch (err) {
    console.error("[STREAM] Failed to update stream info:", err);
  }
}

if (MODULES.greetings || MODULES.game) setInterval(updateStreamInfo, 30 * 1000);
setInterval(() => {
  if (currentStreamId && MODULES.greetings) {
    saveGreetingsToFile(currentStreamId);
  }
}, 5 * 60 * 1000);

function addEmote(code, url, source, emoteId = null, format = null) {
  if (!code || !url) return;

  // Если ID не передан, пытаемся извлечь из URL
  if (!emoteId) {
    // BTTV: https://cdn.betterttv.net/emote/ID/3x
    // 7TV: https://cdn.7tv.app/emote/ID/4x.webp
    // FFZ: могут быть разные форматы
    const bttvMatch = url.match(/betterttv\.net\/emote\/([^\/]+)/);
    const sevenTVMatch = url.match(/7tv\.app\/emote\/([^\/]+)/);
    const ffzMatch = url.match(/\/emoticons\/(\d+)/);

    if (bttvMatch) {
      emoteId = bttvMatch[1];
    } else if (sevenTVMatch) {
      emoteId = sevenTVMatch[1];
    } else if (ffzMatch) {
      emoteId = ffzMatch[1];
    }
  }

  // Определяем формат из URL если не передан
  if (!format && url) {
    if (url.includes('.webp')) format = 'webp';
    else if (url.includes('.gif')) format = 'gif';
    else format = 'png';
  }

  // Для blacklist эмоуты не должны попадать в runtime-карту сообщений,
  // но их ID/format нужно сохранить для GUI (чтобы в списке была картинка).
  if (!isBlacklistedEmote(code)) {
    emoteMap.set(code, url);
  }
  loadedThisRun.add(code);

  if (emoteId) {
    // source ("7TV channel", "Twitch global", ...) нужен панели для вкладок по провайдерам
    emoteNames.set(code, { id: emoteId, format: format || 'png', source });
  }
}

// ---- Запасной список эмоутов на случай недоступного провайдера (7TV в РФ без VPN и т.п.)
// После удачной загрузки запоминаем, какие эмоуты дал каждый провайдер (глобальные — общие, канальные — по id канала).
// Если в следующий раз провайдер не ответил, берём его эмоуты отсюда, а картинки — из cache/emotes.
const PROVIDER_SNAPSHOT_FILE = path.join(CACHE_DIR, "provider_snapshot.json");
const GLOBAL_SOURCES = ["BTTV global", "FFZ global", "7TV global"];
const CHANNEL_SOURCES = ["BTTV channel", "BTTV shared", "FFZ channel", "7TV channel"];
const loadedThisRun = new Set();
const failedSources = new Set();

function readProviderSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(PROVIDER_SNAPSHOT_FILE, "utf8"));
    return { global: data.global || {}, channels: data.channels || {} };
  } catch {
    return { global: {}, channels: {} };
  }
}

function markSourceFailed(source, reason) {
  failedSources.add(source);
  console.log(`[EMOTES] ${source} failed: ${reason}`);
}

function restoreFailedSources(channelId) {
  if (!failedSources.size) return;
  const snapshot = readProviderSnapshot();
  const channelSnap = snapshot.channels[channelId] || {};

  for (const source of failedSources) {
    let entries = GLOBAL_SOURCES.includes(source) ? snapshot.global[source] : channelSnap[source];
    let origin = "snapshot";
    if (!entries) {
      // запасного списка ещё нет (первый запуск этой версии) — берём то, что уже есть в кэше с этим источником
      entries = [...emoteNames.entries()]
        .filter(([, info]) => info && info.source === source)
        .map(([code, info]) => [code, info.id, info.format]);
      origin = "emote cache";
    }

    let restored = 0;
    for (const [code, id, format] of entries) {
      if (loadedThisRun.has(code)) continue; // уже есть от другого провайдера
      const localUrl = getCachedEmoteUrl(id, format || "png");
      if (!localUrl) continue;
      addEmote(code, localUrl, source, id, format);
      restored++;
    }
    console.log(`[EMOTES] ${source} unavailable, using ${restored} cached emotes (from ${origin})`);
  }
}

function saveProviderSnapshot(channelId) {
  const snapshot = readProviderSnapshot();
  const bySource = {};
  for (const code of loadedThisRun) {
    const info = emoteNames.get(code);
    if (!info || !info.source) continue;
    (bySource[info.source] = bySource[info.source] || []).push([code, info.id, info.format]);
  }
  snapshot.channels[channelId] = snapshot.channels[channelId] || {};
  // перезаписываем только то, что в этот раз загрузилось по-настоящему (не из запасного списка)
  for (const source of GLOBAL_SOURCES) {
    if (!failedSources.has(source)) snapshot.global[source] = bySource[source] || [];
  }
  for (const source of CHANNEL_SOURCES) {
    if (!failedSources.has(source)) snapshot.channels[channelId][source] = bySource[source] || [];
  }
  try {
    fs.writeFileSync(PROVIDER_SNAPSHOT_FILE, JSON.stringify(snapshot), "utf8");
  } catch (err) {
    console.error("[CACHE] Failed to save provider snapshot:", err.message);
  }
}

function saveEmoteNames() {
  try {
    const data = {};
    for (const [code, info] of emoteNames.entries()) {
      // Поддержка старого формата (только ID) и нового ({id, format})
      if (typeof info === 'object') {
        data[code] = info;
      } else {
        data[code] = { id: info, format: 'png' };
      }
    }
    fs.writeFileSync(EMOTE_NAMES_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[CACHE] Saved ${Object.keys(data).length} emote names`);
  } catch (err) {
    console.error('[CACHE] Failed to save emote names:', err);
  }
}

// Картинка эмоута приветствия: из загруженных, иначе из кэша на диске (провайдер мог быть недоступен)
function greetingEmoteUrl(code) {
  if (emoteMap.has(code)) return emoteMap.get(code);
  const info = emoteNames.get(code);
  return info ? getCachedEmoteUrl(info.id, info.format || "png") : null;
}

function getRandomGreetingEmote() {
  const available = GREETING_EMOTE_CODES
    .filter(code => !isBlacklistedEmote(code))
    .map(code => ({ code, url: greetingEmoteUrl(code) }))
    .filter(e => e.url);
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function warnMissingGreetingEmotes() {
  const missing = GREETING_EMOTE_CODES.filter(code => !greetingEmoteUrl(code));
  if (!GREETING_EMOTE_CODES.length) {
    console.log("[GREET] No greeting emotes selected - greetings will be shown as text only");
  } else if (missing.length === GREETING_EMOTE_CODES.length) {
    console.log(`[GREET] None of the greeting emotes are available (${missing.join(", ")}) - greetings will be shown as text only`);
  } else if (missing.length) {
    console.log(`[GREET] Some greeting emotes are not available: ${missing.join(", ")}`);
  }
}

function hasUserGreeted(username) {
  const lowerUser = username.toLowerCase();
  const greetTime = greetedUsers.get(lowerUser);

  if (!greetTime) return false;

  const now = Date.now();
  if (now - greetTime > GREETING_EXPIRE_MS) {
    greetedUsers.delete(lowerUser);
    return false;
  }

  return true;
}

// Debounce для сохранения приветствий (избегаем race condition)
let saveGreetingsTimeout = null;
function debouncedSaveGreetings() {
  if (saveGreetingsTimeout) {
    clearTimeout(saveGreetingsTimeout);
  }
  saveGreetingsTimeout = setTimeout(() => {
    if (currentStreamId) {
      saveGreetingsToFile(currentStreamId);
    }
    saveGreetingsTimeout = null;
  }, 2000); // Сохраняем через 2 секунды после последнего изменения
}

function markUserGreeted(username) {
  const lowerUser = username.toLowerCase();
  greetedUsers.set(lowerUser, Date.now());
  console.log(`[GREET] Marked ${username} as greeted`);

  debouncedSaveGreetings();
}

function cleanupExpiredGreetings() {
  const now = Date.now();
  let removed = 0;

  for (const [username, greetTime] of greetedUsers.entries()) {
    if (now - greetTime > GREETING_EXPIRE_MS) {
      greetedUsers.delete(username);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[GREET] Cleaned up ${removed} expired greeting(s)`);
  }
}

setInterval(cleanupExpiredGreetings, 60 * 60 * 1000);

function getUserEmoteCount(username) {
  const lowerUser = username.toLowerCase();
  const timestamps = userEmoteTimestamps.get(lowerUser) || [];
  const now = Date.now();

  // Удаляем старые записи
  const recentTimestamps = timestamps.filter(ts => now - ts < EMOTE_SPAM_WINDOW_MS);

  if (recentTimestamps.length !== timestamps.length) {
    userEmoteTimestamps.set(lowerUser, recentTimestamps);
  }

  return recentTimestamps.length;
}

function canUserSendEmotes(username, count) {
  const currentCount = getUserEmoteCount(username);
  return currentCount + count <= EMOTE_SPAM_LIMIT;
}

function addUserEmotes(username, count) {
  const lowerUser = username.toLowerCase();
  const timestamps = userEmoteTimestamps.get(lowerUser) || [];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    timestamps.push(now);
  }

  userEmoteTimestamps.set(lowerUser, timestamps);
}

function cleanupEmoteTimestamps() {
  const now = Date.now();
  let cleaned = 0;

  for (const [username, timestamps] of userEmoteTimestamps.entries()) {
    const recentTimestamps = timestamps.filter(ts => now - ts < EMOTE_SPAM_WINDOW_MS);

    if (recentTimestamps.length === 0) {
      userEmoteTimestamps.delete(username);
      cleaned++;
    } else if (recentTimestamps.length !== timestamps.length) {
      userEmoteTimestamps.set(username, recentTimestamps);
    }
  }

  if (cleaned > 0) {
    console.log(`[SPAM] Cleaned up ${cleaned} user emote record(s)`);
  }
}

setInterval(cleanupEmoteTimestamps, 60 * 1000);

function normalizeWords(message) {
  return message
    .split(/\s+/)
    .map((w) => w.trim())
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter(Boolean);
}

function extractTwitchTagEmotes(message, tagsEmotes) {
  if (!tagsEmotes || typeof tagsEmotes !== "object") return [];

  const foundMap = new Map();
  const chars = Array.from(message);

  for (const [emoteId, positions] of Object.entries(tagsEmotes)) {
    for (const range of positions) {
      const [startStr, endStr] = String(range).split("-");
      const start = Number(startStr);
      const end = Number(endStr);

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        continue;
      }

      const code = chars.slice(start, end + 1).join("");
      if (!code) continue;

      const key = `${emoteId}:${code}`;
      const existing = foundMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        foundMap.set(key, { id: emoteId, code, count: 1 });
      }
    }
  }

  return Array.from(foundMap.values());
}

async function ensureTwitchEmoteAvailable(emoteId, code) {
  if (!emoteId || !code) return null;
  if (isBlacklistedEmote(code)) return null;

  const cachedGifPath = getEmoteCachePath(emoteId, "gif");
  if (isGifFileValid(cachedGifPath)) {
    const localGifUrl = getCachedEmoteUrl(emoteId, "gif");
    if (localGifUrl) {
      addEmote(code, localGifUrl, "Twitch dynamic", emoteId, "gif");
      removeCachedEmoteFormat(emoteId, "png");
      return localGifUrl;
    }
  }

  const existingFormat = isEmoteCachedAnyFormat(emoteId);
  if (existingFormat && existingFormat !== "png") {
    const localUrl = getCachedEmoteUrl(emoteId, existingFormat);
    if (localUrl) {
      addEmote(code, localUrl, "Twitch dynamic", emoteId, existingFormat);
      return localUrl;
    }
  }

  const candidates = [
    {
      format: "gif",
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/animated/dark/3.0`
    },
    {
      format: "png",
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/static/dark/3.0`
    }
  ];

  for (const candidate of candidates) {
    const savedPath = await downloadEmoteToCache(emoteId, candidate.url, candidate.format);
    if (savedPath) {
      if (candidate.format === "gif") {
        removeCachedEmoteFormat(emoteId, "png");
      }
      const localUrl = getCachedEmoteUrl(emoteId, candidate.format);
      if (localUrl) {
        addEmote(code, localUrl, "Twitch dynamic", emoteId, candidate.format);
        return localUrl;
      }
    }
  }

  const fallbackUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/static/dark/3.0`;
  if (existingFormat === "png") {
    const localPngUrl = getCachedEmoteUrl(emoteId, "png");
    if (localPngUrl) {
      addEmote(code, localPngUrl, "Twitch dynamic", emoteId, "png");
      return localPngUrl;
    }
  }

  addEmote(code, fallbackUrl, "Twitch dynamic", emoteId, "png");
  return fallbackUrl;
}

async function getTwitchAppToken() {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Twitch token error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function getTwitchUserByLogin(login, appAccessToken) {
  const res = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${appAccessToken}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Get Users error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.data || !data.data.length) {
    throw new Error(`Twitch user not found for login: ${login}`);
  }

  return data.data[0];
}

async function loadGlobalEmotes() {
  const [bttvRes, ffzRes, sevenRes] = await Promise.allSettled([
    fetch("https://api.betterttv.net/3/cached/emotes/global"),
    fetch("https://api.frankerfacez.com/v1/set/global"),
    fetch("https://7tv.io/v3/emote-sets/global"),
  ]);

  // BTTV Global
  if (bttvRes.status === "fulfilled" && bttvRes.value.ok) {
    const data = await bttvRes.value.json();

    const emotesList = data.map(e => ({
      id: e.id,
      name: e.code,
      format: e.imageType === "gif" ? "gif" : "png",
      url: `https://cdn.betterttv.net/emote/${e.id}/3x`
    }));

    const { downloaded, cached } = await downloadEmotesParallel(emotesList, 15);

    for (const emote of emotesList) {
      const localUrl = getCachedEmoteUrl(emote.id, emote.format);
      if (localUrl) {
        addEmote(emote.name, localUrl, "BTTV global", emote.id);
      }
    }
    console.log(`[EMOTES] BTTV global loaded: ${data.length} (cached: ${cached}, downloaded: ${downloaded})`);
  } else {
    markSourceFailed("BTTV global", describeFailure(bttvRes));
  }

  // FFZ Global
  if (ffzRes.status === "fulfilled" && ffzRes.value.ok) {
    const data = await ffzRes.value.json();
    const r = await addFfzEmotes(ffzSetsToList(data.sets), "FFZ global");
    console.log(`[EMOTES] FFZ global loaded: ${r.count} (cached: ${r.cached}, downloaded: ${r.downloaded}, failed: ${r.failed})`);
  } else {
    markSourceFailed("FFZ global", describeFailure(ffzRes));
  }

  // 7TV Global
  if (sevenRes.status === "fulfilled" && sevenRes.value.ok) {
    const data = await sevenRes.value.json();
    const emotes = data.emotes || [];

    const emotesList = emotes.map(e => ({
      id: e.id,
      name: e.name,
      format: "webp",
      url: `https://cdn.7tv.app/emote/${e.id}/4x.webp`
    }));

    const { downloaded, cached, failed } = await downloadEmotesParallel(emotesList, 15);

    for (const emote of emotesList) {
      const localUrl = getCachedEmoteUrl(emote.id, emote.format);
      if (localUrl) {
        addEmote(emote.name, localUrl, "7TV global", emote.id);
      }
    }
    console.log(`[EMOTES] 7TV global loaded: ${emotes.length} (cached: ${cached}, downloaded: ${downloaded}, failed: ${failed})`);
  } else {
    markSourceFailed("7TV global", describeFailure(sevenRes));
  }
}

// Почему не ответил провайдер: ошибка сети/таймаут или HTTP-статус
function describeFailure(settled) {
  if (settled.status === "rejected") {
    const err = settled.reason || {};
    return err.name === "TimeoutError" || err.name === "AbortError" ? `timeout ${FETCH_TIMEOUT_MS / 1000}s` : (err.code || err.message || String(err));
  }
  return `HTTP ${settled.value.status}`;
}

async function loadChannelBTTVEmotes(channelId) {
  const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
  if (!res.ok) {
    throw new Error(`BTTV channel error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  const allEmotes = [
    ...(data.channelEmotes || []).map(e => ({ ...e, source: "BTTV channel" })),
    ...(data.sharedEmotes || []).map(e => ({ ...e, source: "BTTV shared" }))
  ];

  const emotesList = allEmotes.map(e => ({
    id: e.id,
    name: e.code,
    format: e.imageType === "gif" ? "gif" : "png",
    url: `https://cdn.betterttv.net/emote/${e.id}/3x`,
    source: e.source
  }));

  const { downloaded, cached } = await downloadEmotesParallel(emotesList, 15);

  let count = 0;
  for (const emote of emotesList) {
    const localUrl = getCachedEmoteUrl(emote.id, emote.format);
    if (localUrl) {
      addEmote(emote.name, localUrl, emote.source, emote.id);
      count++;
    }
  }

  console.log(`[EMOTES] BTTV channel loaded: ${count} (cached: ${cached}, downloaded: ${downloaded})`);
}

// FFZ id — числа, как и у Twitch, поэтому в кэше храним их с префиксом, чтобы файлы не перепутались
function ffzSetsToList(sets) {
  const list = [];
  for (const set of Object.values(sets || {})) {
    for (const e of set.emoticons || []) {
      const animated = e.animated && (e.animated["4"] || e.animated["2"] || e.animated["1"]);
      const still = e.urls && (e.urls["4"] || e.urls["2"] || e.urls["1"]);
      const url = animated || still;
      if (!url || !e.name) continue;
      list.push({
        id: `ffz_${e.id}`,
        name: e.name,
        format: animated ? "webp" : "png",
        url: url.startsWith("http") ? url : `https:${url}`,
      });
    }
  }
  return list;
}

async function addFfzEmotes(list, source) {
  const { downloaded, cached, failed } = await downloadEmotesParallel(list, 15);
  for (const emote of list) {
    // если скачать не вышло — показываем с CDN, чтобы эмоут всё равно работал в оверлее
    const localUrl = getCachedEmoteUrl(emote.id, emote.format);
    addEmote(emote.name, localUrl || emote.url, source, emote.id, emote.format);
  }
  return { count: list.length, downloaded, cached, failed };
}

async function loadChannelFFZEmotes(channelId) {
  const res = await fetch(`https://api.frankerfacez.com/v1/room/id/${channelId}`);
  if (res.status === 404) {
    console.log("[EMOTES] FFZ channel loaded: 0 (no FFZ room)");
    return;
  }
  if (!res.ok) {
    throw new Error(`FFZ channel error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const r = await addFfzEmotes(ffzSetsToList(data.sets), "FFZ channel");
  console.log(`[EMOTES] FFZ channel loaded: ${r.count} (cached: ${r.cached}, downloaded: ${r.downloaded}, failed: ${r.failed})`);
}

async function loadChannel7TVEmotes(channelId) {
  const userRes = await fetch(`https://7tv.io/v3/users/twitch/${channelId}`);
  if (!userRes.ok) {
    throw new Error(`7TV user error: ${userRes.status} ${await userRes.text()}`);
  }

  const user = await userRes.json();
  const emoteSet = user?.emote_set || user?.emoteSet;

  if (!emoteSet?.emotes?.length) {
    console.log("[EMOTES] 7TV channel loaded: 0");
    return;
  }

  const emotesList = emoteSet.emotes.map(e => ({
    id: e.id,
    name: e.name,
    format: "webp",
    url: `https://cdn.7tv.app/emote/${e.id}/4x.webp`
  }));

  const { downloaded, cached } = await downloadEmotesParallel(emotesList, 15);

  let count = 0;
  for (const emote of emotesList) {
    const localUrl = getCachedEmoteUrl(emote.id, emote.format);
    if (localUrl) {
      addEmote(emote.name, localUrl, "7TV channel", emote.id);
      count++;
    }
  }

  console.log(`[EMOTES] 7TV channel loaded: ${count} (cached: ${cached}, downloaded: ${downloaded})`);
}

async function loadAllEmotesForChannel(channelLogin) {
  console.log(`[EMOTES] Resolving Twitch user for channel: ${channelLogin}`);
  loadedThisRun.clear();
  failedSources.clear();

  const tokenData = await getTwitchAppToken();
  const appAccessToken = tokenData.access_token;

  const user = await getTwitchUserByLogin(channelLogin, appAccessToken);
  console.log(`[TWITCH] Channel resolved: ${user.login} -> id=${user.id}`);

  console.log("[EMOTES] Loading Twitch global emotes...");
  await loadTwitchGlobalEmotes(appAccessToken);

  console.log("[EMOTES] Loading 3rd party global emotes...");
  await loadGlobalEmotes();

  console.log("[EMOTES] Loading Twitch channel emotes...");
  await loadTwitchChannelEmotes(user.id, appAccessToken);

  console.log("[EMOTES] Loading 3rd party channel emotes...");
  const channelLoads = await Promise.allSettled([
    loadChannelBTTVEmotes(user.id),
    loadChannelFFZEmotes(user.id),
    loadChannel7TVEmotes(user.id),
  ]);
  const channelSources = [["BTTV channel", "BTTV shared"], ["FFZ channel"], ["7TV channel"]];
  channelLoads.forEach((result, i) => {
    if (result.status === "rejected") {
      for (const source of channelSources[i]) markSourceFailed(source, describeFailure(result));
    }
  });

  restoreFailedSources(user.id);
  saveProviderSnapshot(user.id);

  console.log(`[EMOTES] Total loaded: ${emoteMap.size} emotes`);
  saveEmoteNames();
  warnMissingGreetingEmotes();
}

const client = new tmi.Client({
  options: { debug: true },
  connection: { reconnect: true, secure: true },
  channels: [CHANNEL],
});

console.log(`[TMI] Using anonymous mode (read-only)`);

client.on("connected", (addr, port) => {
  console.log(`[TMI] Connected: ${addr}:${port}`);
});

client.on("join", (channel, username, self) => {
  if (self) console.log(`[TMI] Joined ${channel}`);
});

client.on("message", async (channel, tags, message, self) => {
  if (self) return;

  try {
    const username = tags["display-name"] || tags.username || "unknown";
    console.log(`[CHAT] ${username}: ${message}`);

    // команда эдита: "!edit" — запустить (повтор продлевает), "!edit stop" — остановить
    const editCommand = String(config.editCommand || "").trim().toLowerCase();
    const [firstWord, secondWord] = message.trim().toLowerCase().split(/\s+/);
    if (config.editEnabled && editCommand && firstWord === editCommand) {
      if (!canTriggerEdit(tags)) {
        console.log(`[EDIT] ${username} has no rights for ${editCommand}`);
      } else if (secondWord === "stop" || secondWord === "стоп") {
        await edit.stop(`остановил ${username}`);
      } else {
        await edit.start({ by: username }).catch(err => console.log(`[EDIT] ${username}: ${err.message}`));
      }
      return;
    }

    const words = normalizeWords(message);
    const wordsLower = words.map(w => w.toLowerCase());
    const rawTokens = message
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean);

    const hasGreeting = MODULES.greetings && GREETING_KEYWORDS.some(keyword => wordsLower.includes(keyword));

    if (hasGreeting && !hasUserGreeted(username)) {
      // без доступного эмоута приветствие всё равно показываем — одним текстом
      const greetingEmote = getRandomGreetingEmote() || { code: null, url: null };
      {
        console.log(`[GREET] ${username} greeted for the first time!${greetingEmote.url ? "" : " (no emote available, text only)"}`);
        const soundFile = getGreetingSoundForUser(username);
        broadcastGreeting({
          type: "greeting",
          code: greetingEmote.code,
          url: greetingEmote.url,
          user: username,
          sound: soundFile,
          style: GREETING_STYLE,
          displayMs: GREETING_DISPLAY_MS,
          volume: GREETING_VOLUME,
        });
        markUserGreeted(username);
      }
    } else if (hasGreeting) {
      console.log(`[GREET] ${username} already greeted (skipping)`);
    }

    if (!hasGreeting && MODULES.emotes) {
      // Собираем все эмоуты из сообщения
      const foundEmotes = new Map();

      const pushFoundEmote = (code, url, count = 1) => {
        if (!code || !url) return;
        const existing = foundEmotes.get(code);
        if (existing) {
          existing.count += count;
          existing.url = url;
        } else {
          foundEmotes.set(code, { url, count });
        }
      };

      for (const token of rawTokens) {
        const url = emoteMap.get(token);
        if (url) {
          if (!isBlacklistedEmote(token)) {
            pushFoundEmote(token, url);
          }
        }
      }

      const twitchTagEmotes = extractTwitchTagEmotes(message, tags.emotes);
      for (const twitchEmote of twitchTagEmotes) {
        if (isBlacklistedEmote(twitchEmote.code)) continue;

        let url = emoteMap.get(twitchEmote.code);
        if (!url) {
          url = await ensureTwitchEmoteAvailable(twitchEmote.id, twitchEmote.code);
        }

        if (url) {
          // Если эмоут уже посчитан по raw token, здесь только обновляем url (без +count),
          // чтобы не удваивать количество из одного и того же сообщения.
          if (foundEmotes.has(twitchEmote.code)) {
            const existing = foundEmotes.get(twitchEmote.code);
            existing.url = url;
          } else {
            pushFoundEmote(twitchEmote.code, url, twitchEmote.count || 1);
          }
        }
      }

      const totalEmotesInMessage = Array.from(foundEmotes.values()).reduce((sum, e) => sum + (e.count || 0), 0);

      if (totalEmotesInMessage > 0) {
        // Проверяем антиспам
        if (canUserSendEmotes(username, totalEmotesInMessage)) {
          const emoteSummary = Array.from(foundEmotes.entries()).map(([code, info]) => info.count > 1 ? `${code}x${info.count}` : code);
          console.log(`[EMOTE] ${username} sent ${totalEmotesInMessage} emote(s): ${emoteSummary.join(', ')}`);

          // Показываем все эмоуты сразу
          for (const [code, info] of foundEmotes.entries()) {
            const repeats = Math.max(1, info.count || 1);
            for (let i = 0; i < repeats; i++) {
              broadcastEmotes({
                type: "emote",
                code,
                url: info.url,
                user: username,
                boostOnSameFromDifferentUser: EMOTE_BOOST_ON_SAME_FROM_DIFFERENT_USER,
                boostScaleStep: EMOTE_BOOST_SCALE_STEP,
                displayDurationMs: EMOTE_DISPLAY_MS,
                size: EMOTE_SIZE,
                ...(EMOTE_ZONES.length ? { zones: EMOTE_ZONES } : {}),
              });
            }
          }

          addUserEmotes(username, totalEmotesInMessage);
        } else {
          const currentCount = getUserEmoteCount(username);
          console.log(`[SPAM] ${username} blocked: ${currentCount}/${EMOTE_SPAM_LIMIT} emotes in last ${EMOTE_SPAM_WINDOW_MS / 1000}s`);
        }
      }
    } else if (hasGreeting && MODULES.emotes) {
      console.log(`[EMOTE] Skipping emotes - message is a greeting`);
    }
  } catch (err) {
    console.error("[MESSAGE] Handler error:", err);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[PROCESS] Uncaught exception:", err);
});

process.on("SIGINT", async () => {
  console.log("\n[PROCESS] Shutting down...");
  await Promise.all([edit.shutdown(), rewards.shutdown()]);
  savePlaytime();
  if (currentStreamId) {
    saveGreetingsToFile(currentStreamId);
    console.log("[GREETINGS] Saved before exit");
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[PROCESS] Shutting down...");
  await Promise.all([edit.shutdown(), rewards.shutdown()]);
  savePlaytime();
  if (currentStreamId) {
    saveGreetingsToFile(currentStreamId);
    console.log("[GREETINGS] Saved before exit");
  }
  process.exit(0);
});

function scheduleEmoteReload() {
  setTimeout(async () => {
    try {
      await loadAllEmotesForChannel(CHANNEL);
    } catch (err) {
      console.error("[EMOTES] Reload failed, will retry in 60s:", err.message);
      scheduleEmoteReload();
    }
  }, 60 * 1000);
}

(async () => {
  try {
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("🎮 Twitch Bot Starting...");
    console.log("═══════════════════════════════════════════════════════\n");

    console.log(`[MODULES] emotes: ${onOff(MODULES.emotes)}, greetings: ${onOff(MODULES.greetings)}, edit: ${onOff(config.editEnabled === true)}, game: ${onOff(MODULES.game)}`);
    ensureCacheDir();
    if (MODULES.greetings) {
      ensureGreetingsDir();
      cleanupOldGreetingFiles();
      loadSoundFiles();
    }

    // эмоуты нужны и оверлею эмоутов, и приветствиям (картинка приветствия)
    if (MODULES.emotes || MODULES.greetings) {
      loadCachedEmoteNames();
      try {
        await loadAllEmotesForChannel(CHANNEL);
      } catch (err) {
        console.error("[BOOT] Emote loading failed, will retry in 60s:", err);
        scheduleEmoteReload();
      }
    }

    console.log("\n───────────────────────────────────────────────────────");
    console.log("📺 Checking recent streams...");
    console.log("───────────────────────────────────────────────────────\n");

    let recentStreams = [];
    try {
      const tokenData = await getTwitchAppToken();
      const appAccessToken = tokenData.access_token;
      const user = await getTwitchUserByLogin(CHANNEL, appAccessToken);
      recentStreams = await getRecentStreams(user.id, appAccessToken, 3);
    } catch (err) {
      console.error("[BOOT] Failed to fetch recent streams:", err.message);
    }

    if (recentStreams.length > 0) {
      console.log(`Last ${recentStreams.length} stream(s) for ${CHANNEL}:\n`);

      recentStreams.forEach((stream, index) => {
        const date = new Date(stream.created_at);
        const duration = stream.duration;

        console.log(`${index + 1}. ${stream.title}`);
        console.log(`   📅 Date: ${date.toLocaleString('ru-RU')}`);
        console.log(`   ⏱️  Duration: ${duration}`);
        console.log(`   🎮 Game: ${stream.type === 'archive' ? 'VOD' : stream.type}`);
        console.log(`   👀 Views: ${stream.view_count}`);
        console.log(`   🔗 URL: ${stream.url}\n`);
      });
    } else {
      console.log("No recent streams found.\n");
    }

    console.log("───────────────────────────────────────────────────────\n");

    if (MODULES.greetings || MODULES.game) {
      try {
        await updateStreamInfo();
      } catch (err) {
        console.error("[BOOT] Failed to fetch stream info:", err.message);
      }
    }
    await client.connect();

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("✅ Bot is ready!");
    console.log("═══════════════════════════════════════════════════════\n");
  } catch (err) {
    console.error("[BOOT] Startup failed:", err);
  }
})();