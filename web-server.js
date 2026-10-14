const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const { listSystemFonts } = require("./system-fonts");
const { GREETING_ANIMATIONS } = require("./overlay/animations.js");
const updates = require("./updates");
const ANIMATION_KEYS = new Set(GREETING_ANIMATIONS.map(a => a.key));

const WEB_PORT = Number(process.env.WEB_PORT) || 3001;
const CONFIG_FILE = path.join(__dirname, "bot-config.json");

const DEFAULT_CONFIG = {
  channel: "",
  twitchClientId: "",
  twitchClientSecret: "",
  port: 3000,
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

let serverProcess = null;
let restarting = false; // во время перезапуска панель показывает "Запуск", а не "Остановлен"
let runningBotPort = null;
let config = DEFAULT_CONFIG;
let botStarting = false;

// Проверка состояния процесса
function isProcessRunning() {
  if (!serverProcess) return false;
  try {
    // process.kill(pid, 0) не убивает процесс, а проверяет существование
    process.kill(serverProcess.pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

// Загрузка конфигурации
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const fromFile = JSON.parse(data);
      // старый конфиг: один источник эдита (editCameraSource) → список editSources
      if (!Array.isArray(fromFile.editSources) && typeof fromFile.editCameraSource === "string" && fromFile.editCameraSource) {
        fromFile.editSources = [fromFile.editCameraSource];
      }
      delete fromFile.editCameraSource;
      config = { ...DEFAULT_CONFIG, ...fromFile };
      console.log("[CONFIG] Loaded from file");
    }
  } catch (err) {
    console.error("[CONFIG] Failed to load:", err);
  }
}

// Сохранение конфигурации
function saveConfig(newConfig) {
  try {
    config = newConfig;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log("[CONFIG] Saved to file");
    return true;
  } catch (err) {
    console.error("[CONFIG] Failed to save:", err);
    return false;
  }
}

async function requestGracefulShutdown() {
  try {
    await fetch(`http://127.0.0.1:${runningBotPort || config.port || 3000}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1500)
    });
  } catch {
    // bot not reachable - fall back to kill
  }
}

// "https://twitch.tv/Name", "#Name", " name " -> "name"
function normalizeChannel(value) {
  if (typeof value !== "string") return DEFAULT_CONFIG.channel;
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "")
    .replace(/^#/, "")
    .split(/[/?#\s]/)[0]
    .toLowerCase();
}

// Приведение конфигурации к ожидаемым типам (защита бота от некорректного ввода)
// Зоны без эмоутов: прямоугольник, эллипс или многоугольник (нарисованный от руки) в координатах оверлея 900×600
function sanitizeZones(list) {
  if (!Array.isArray(list)) return [];
  const int = (v, max) => Math.round(Math.min(max, Math.max(0, Number(v) || 0)));
  const out = [];
  for (const z of list.slice(0, 20)) {
    if (!z || typeof z !== "object") continue;
    if (z.type === "rect") {
      const zone = { type: "rect", x: int(z.x, 900), y: int(z.y, 600), w: int(z.w, 900), h: int(z.h, 600) };
      if (zone.w && zone.h) out.push(zone);
    } else if (z.type === "ellipse") {
      const zone = { type: "ellipse", cx: int(z.cx, 900), cy: int(z.cy, 600), rx: int(z.rx, 900), ry: int(z.ry, 600) };
      if (zone.rx && zone.ry) out.push(zone);
    } else if (z.type === "poly" && Array.isArray(z.points)) {
      const points = z.points.slice(0, 300).filter(p => Array.isArray(p)).map(p => [int(p[0], 900), int(p[1], 600)]);
      if (points.length >= 3) out.push({ type: "poly", points });
    }
  }
  return out;
}

function sanitizeConfig(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const str = (v, d) => (typeof v === "string" ? v.trim() : d);
  const num = (v, d, { min = 0, int = false } = {}) => {
    const n = Number(v);
    if (v === "" || v === null || !Number.isFinite(n) || n < min) return d;
    return int ? Math.floor(n) : n;
  };
  const list = (v, d) =>
    Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : d;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  // анимации появления: только известные ключи; старый конфиг хранил одну строку greetingAnimation
  const animations = (s) => {
    const raw = Array.isArray(s.greetingAnimations) ? s.greetingAnimations : [s.greetingAnimation];
    const valid = [...new Set(raw.filter(k => ANIMATION_KEYS.has(k)))];
    return valid.length ? valid : DEFAULT_CONFIG.greetingAnimations.slice();
  };
  const color = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toUpperCase() : d);
  // имя шрифта попадает в CSS font-family — оставляем только безопасные символы
  const fontName = (v) => {
    const clean = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) : "";
    return clean || DEFAULT_CONFIG.greetingFontFamily;
  };

  return {
    ...src,
    channel: normalizeChannel(src.channel),
    twitchClientId: str(src.twitchClientId, DEFAULT_CONFIG.twitchClientId),
    twitchClientSecret: str(src.twitchClientSecret, DEFAULT_CONFIG.twitchClientSecret),
    port: num(src.port, DEFAULT_CONFIG.port, { min: 1, int: true }),
    greetingKeywords: list(src.greetingKeywords, DEFAULT_CONFIG.greetingKeywords),
    greetingEmotes: list(src.greetingEmotes, DEFAULT_CONFIG.greetingEmotes),
    emoteBlacklist: list(src.emoteBlacklist, DEFAULT_CONFIG.emoteBlacklist),
    emoteSpamLimit: num(src.emoteSpamLimit, DEFAULT_CONFIG.emoteSpamLimit, { int: true }),
    emoteSpamWindow: num(src.emoteSpamWindow, DEFAULT_CONFIG.emoteSpamWindow, { min: 1 }),
    emoteBoostOnSameFromDifferentUser: src.emoteBoostOnSameFromDifferentUser !== false,
    emoteBoostScalePercent: num(src.emoteBoostScalePercent, DEFAULT_CONFIG.emoteBoostScalePercent),
    greetingExpireDays: num(src.greetingExpireDays, DEFAULT_CONFIG.greetingExpireDays, { min: 0.01 }),
    oldFilesExpireDays: num(src.oldFilesExpireDays, DEFAULT_CONFIG.oldFilesExpireDays, { min: 0.01 }),
    emoteDisplaySeconds: clamp(num(src.emoteDisplaySeconds, DEFAULT_CONFIG.emoteDisplaySeconds, { min: 1 }), 1, 120),
    emoteSize: clamp(num(src.emoteSize, DEFAULT_CONFIG.emoteSize, { min: 24, int: true }), 24, 600),
    emoteExcludeZones: sanitizeZones(src.emoteExcludeZones),
    greetingDisplaySeconds: clamp(num(src.greetingDisplaySeconds, DEFAULT_CONFIG.greetingDisplaySeconds, { min: 1 }), 1, 120),
    greetingVolume: clamp(num(src.greetingVolume, DEFAULT_CONFIG.greetingVolume, { int: true }), 0, 100),
    greetingFontFamily: fontName(src.greetingFontFamily),
    greetingFontSize: clamp(num(src.greetingFontSize, DEFAULT_CONFIG.greetingFontSize, { min: 12, int: true }), 12, 120),
    greetingBold: src.greetingBold !== false,
    greetingTextColor: color(src.greetingTextColor, DEFAULT_CONFIG.greetingTextColor),
    greetingOutlineColor: color(src.greetingOutlineColor, DEFAULT_CONFIG.greetingOutlineColor),
    greetingOutlineWidth: clamp(num(src.greetingOutlineWidth, DEFAULT_CONFIG.greetingOutlineWidth), 0, 10),
    greetingShadow: src.greetingShadow !== false,
    greetingEmoteSize: clamp(num(src.greetingEmoteSize, DEFAULT_CONFIG.greetingEmoteSize, { min: 40, int: true }), 40, 340),
    greetingTemplate: typeof src.greetingTemplate === "string" && src.greetingTemplate.trim()
      ? src.greetingTemplate.trim().slice(0, 120)
      : DEFAULT_CONFIG.greetingTemplate,
    greetingAnimations: animations(src),
    gameElementX: clamp(num(src.gameElementX, DEFAULT_CONFIG.gameElementX, { int: true }), 0, 1920),
    gameElementY: clamp(num(src.gameElementY, DEFAULT_CONFIG.gameElementY, { int: true }), 0, 1080),
    gameElementScale: clamp(num(src.gameElementScale, DEFAULT_CONFIG.gameElementScale, { min: 10, int: true }), 10, 400),
    // до трёх строк, {game} и {time} подставляет оверлей
    gameElementTemplate: typeof src.gameElementTemplate === "string" && src.gameElementTemplate.trim()
      ? src.gameElementTemplate.replace(/\r/g, "").split("\n").map(s => s.trim()).filter(Boolean).slice(0, 3).join("\n").slice(0, 120)
      : DEFAULT_CONFIG.gameElementTemplate,
    gameShowBoxArt: src.gameShowBoxArt !== false,
    gameShowPaused: src.gameShowPaused !== false,
    gameHideWhenNoGame: src.gameHideWhenNoGame !== false,
    gameIdleMinutes: clamp(num(src.gameIdleMinutes, DEFAULT_CONFIG.gameIdleMinutes, { min: 1 }), 1, 60),
    gameFontFamily: fontName(src.gameFontFamily),
    gameFontSize: clamp(num(src.gameFontSize, DEFAULT_CONFIG.gameFontSize, { min: 12, int: true }), 12, 120),
    gameBold: src.gameBold !== false,
    gameTextColor: color(src.gameTextColor, DEFAULT_CONFIG.gameTextColor),
    gameOutlineColor: color(src.gameOutlineColor, DEFAULT_CONFIG.gameOutlineColor),
    gameOutlineWidth: clamp(num(src.gameOutlineWidth, DEFAULT_CONFIG.gameOutlineWidth), 0, 10),
    gameShadow: src.gameShadow !== false,
    editEnabled: src.editEnabled === true,
    obsHost: typeof src.obsHost === "string" && /^[\w.-]{1,100}$/.test(src.obsHost.trim()) ? src.obsHost.trim() : DEFAULT_CONFIG.obsHost,
    obsPort: clamp(num(src.obsPort, DEFAULT_CONFIG.obsPort, { min: 1, int: true }), 1, 65535),
    obsPassword: typeof src.obsPassword === "string" ? src.obsPassword.slice(0, 200) : "",
    // источники видео для эдита; старый конфиг хранил один — editCameraSource
    editSources: [...new Set((Array.isArray(src.editSources) ? src.editSources : typeof src.editCameraSource === "string" && src.editCameraSource ? [src.editCameraSource] : [])
      .filter(n => typeof n === "string" && n.trim()).map(n => n.slice(0, 200)))].slice(0, 20),
    editAudioSource: typeof src.editAudioSource === "string" ? src.editAudioSource.slice(0, 200) : "",
    editCommand: typeof src.editCommand === "string" && src.editCommand.trim() ? src.editCommand.trim().split(/\s+/)[0].slice(0, 40) : DEFAULT_CONFIG.editCommand,
    editDuration: clamp(num(src.editDuration, DEFAULT_CONFIG.editDuration, { min: 5, int: true }), 5, 600),
    editCooldown: clamp(num(src.editCooldown, DEFAULT_CONFIG.editCooldown, { int: true }), 0, 3600),
    editWho: Array.isArray(src.editWho)
      ? [...new Set(src.editWho.filter(w => ["broadcaster", "moderator", "vip", "subscriber", "everyone"].includes(w)))]
      : DEFAULT_CONFIG.editWho.slice(),
    editIntensity: clamp(num(src.editIntensity, DEFAULT_CONFIG.editIntensity, { int: true }), 10, 250),
    editEffects: Array.isArray(src.editEffects)
      ? [...new Set(src.editEffects.filter(e => EDIT_EFFECTS.includes(e)))]
      : DEFAULT_CONFIG.editEffects.slice(),
    editLatencyMs: clamp(num(src.editLatencyMs, DEFAULT_CONFIG.editLatencyMs, { int: true }), 0, 500),
    editAlwaysPunch: src.editAlwaysPunch !== false,
    editBoxPulse: src.editBoxPulse !== false,
    editBoxPulseAmount: clamp(num(src.editBoxPulseAmount, DEFAULT_CONFIG.editBoxPulseAmount, { int: true }), 0, 60),
    editRewardEnabled: src.editRewardEnabled === true,
    editRewardTitle: typeof src.editRewardTitle === "string" && src.editRewardTitle.trim()
      ? src.editRewardTitle.trim().slice(0, 45) : DEFAULT_CONFIG.editRewardTitle,
    editRewardCost: clamp(num(src.editRewardCost, DEFAULT_CONFIG.editRewardCost, { min: 1, int: true }), 1, 10000000),
    editRewardDuration: clamp(num(src.editRewardDuration, DEFAULT_CONFIG.editRewardDuration, { min: 5, int: true }), 5, 600),
    editRewardBoost: clamp(num(src.editRewardBoost, DEFAULT_CONFIG.editRewardBoost, { int: true }), 0, 100),
    moduleEmotes: src.moduleEmotes !== false,
    moduleGreetings: src.moduleGreetings !== false,
    moduleGame: src.moduleGame === true
  };
}

// Ключи элемента «Текущая игра» и эдита: их изменение не требует перезапуска бота
const isGameKey = (key) => key.startsWith("game");
const isEditKey = (key) => key.startsWith("edit") || key.startsWith("obs");
const EDIT_EFFECTS = require("./edit").EFFECT_KEYS;

// Запрос к API запущенного бота
function botFetch(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${runningBotPort || config.port || 3000}${pathname}`, {
    signal: AbortSignal.timeout(3000),
    ...options,
  });
}

// Остановка бота
function stopBot() {
  return new Promise((resolve) => {
    if (!serverProcess || !isProcessRunning()) {
      serverProcess = null;
      broadcast({ type: "status", running: false, starting: restarting });
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      if (serverProcess && isProcessRunning()) {
        console.log("[BOT] Force killing process...");
        serverProcess.kill('SIGKILL');
        serverProcess = null;
      }
      resolve(true);
    }, 3000);

    serverProcess.once('close', () => {
      clearTimeout(timeout);
      serverProcess = null;
      broadcast({ type: "status", running: false, starting: restarting });
      broadcast({ type: "log", message: "[BOT] Stopped" });
      resolve(true);
    });

    try {
      // On Windows kill() is a hard kill, so ask the bot to save state and exit itself first
      requestGracefulShutdown().finally(() => {
        try {
          if (serverProcess) serverProcess.kill('SIGTERM');
        } catch {}
      });
    } catch (err) {
      console.error("[BOT] Error killing process:", err);
      clearTimeout(timeout);
      serverProcess = null;
      resolve(true);
    }
  });
}

// Запуск бота
function startBot() {
  if (botStarting) {
    console.log("[BOT] Already starting...");
    return;
  }

  if (serverProcess && isProcessRunning()) {
    console.log("[BOT] Already running");
    return;
  }

  botStarting = true;
  broadcast({ type: "status", running: false, starting: true });
  broadcast({ type: "log", message: "[BOT] Starting..." });

  const env = {
    ...process.env,
    CONFIG: JSON.stringify(config)
  };

  runningBotPort = config.port || 3000;
  serverProcess = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, cwd: __dirname });

  serverProcess.stdout.on("data", (data) => {
    const log = data.toString().trim();
    console.log(log);
    broadcast({ type: "log", message: log });
  });

  serverProcess.stderr.on("data", (data) => {
    const log = data.toString().trim();
    console.error(log);
    broadcast({ type: "log", message: `[ERROR] ${log}` });
  });

  serverProcess.on("close", (code) => {
    console.log(`[BOT] Process exited with code ${code}`);
    broadcast({ type: "log", message: `[BOT] Process exited with code ${code}` });
    broadcast({ type: "status", running: false, starting: restarting });
    serverProcess = null;
    botStarting = false;
  });

  // Даем процессу время запуститься
  setTimeout(() => {
    if (isProcessRunning()) {
      broadcast({ type: "status", running: true });
      botStarting = false;
    }
  }, 2000);
}

// Перезапуск бота
async function restartBot() {
  broadcast({ type: "log", message: "[BOT] Restarting..." });
  restarting = true;
  try {
    await stopBot();
    // Даем время на полную остановку процесса
    await new Promise(resolve => setTimeout(resolve, 2000));
  } finally {
    restarting = false;
  }
  startBot();
}

// Web server
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "web-gui")));
app.use("/cache", express.static(path.join(__dirname, "cache")));
app.use("/overlay", express.static(path.join(__dirname, "overlay")));
app.use("/sounds", express.static(path.join(__dirname, "sounds"))); // прослушивание в панели

const server = app.listen(WEB_PORT, "127.0.0.1", () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  🎮 Twitch Bot Web Control Panel  ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
  console.log(`  Open in browser:`);
  console.log(`  👉 http://localhost:${WEB_PORT}\n`);
});

// WebSocket for logs
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("[WS] Client connected to control panel");

  // Отправляем текущую конфигурацию
  ws.send(JSON.stringify({
    type: "config",
    config: config
  }));

  // Отправляем реальный статус бота
  const actualStatus = isProcessRunning();
  ws.send(JSON.stringify({
    type: "status",
    running: actualStatus
  }));

  console.log(`[WS] Sent status: ${actualStatus ? 'running' : 'stopped'}`);
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// API endpoints
app.get("/api/config", (req, res) => {
  res.json(config);
});

app.post("/api/config", async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ success: false, error: "Invalid config" });
    return;
  }

  const previous = config;
  if (saveConfig(sanitizeConfig(req.body))) {
    let restarting = isProcessRunning();

    // Поменялся только элемент «Текущая игра» — отдаём настройки работающему боту, без перезапуска чата и эмоутов
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(config)])]
      .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(config[key]));
    if (restarting && changed.length && changed.every(key => isGameKey(key) || isEditKey(key))) {
      try {
        const send = async (pathname, test) => {
          if (!changed.some(test)) return true;
          const settings = Object.fromEntries(Object.keys(config).filter(test).map(key => [key, config[key]]));
          const r = await botFetch(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
          return r.ok;
        };
        if ((await send("/api/game/overlay", isGameKey)) && (await send("/api/edit/config", isEditKey))) restarting = false;
      } catch {}
    }

    res.json({ success: true, config, restarting });

    broadcast({ type: "config", config });
    broadcast({ type: "log", message: "[CONFIG] Configuration saved" });

    // Перезапуск бота если он запущен (после ответа, чтобы панель не ждала)
    if (restarting) {
      broadcast({ type: "log", message: "[CONFIG] Restarting bot with new configuration..." });
      restartBot();
    }
  } else {
    res.status(500).json({ success: false, error: "Failed to save config" });
  }
});

// ---- звуки приветствий: папка sounds (подпапки — наборы звуков)
const SOUNDS_DIR = path.join(__dirname, "sounds");
const SOUND_EXT = new Set([".mp3", ".ogg", ".wav"]);

function listSounds() {
  const folders = new Map(); // относительная папка -> файлы
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SOUND_EXT.has(path.extname(entry.name).toLowerCase())) {
        const folder = path.relative(SOUNDS_DIR, dir).replace(/\\/g, "/");
        if (!folders.has(folder)) folders.set(folder, []);
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        folders.get(folder).push({
          name: entry.name,
          path: path.relative(__dirname, full).replace(/\\/g, "/"), // как его отдаёт бот оверлею: sounds/...
          size,
        });
      }
    }
  };
  walk(SOUNDS_DIR);

  const byName = (a, b) => a.localeCompare(b, "ru", { numeric: true, sensitivity: "base" });
  const list = [...folders.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([folder, files]) => ({ folder, files: files.sort((x, y) => byName(x.name, y.name)) }));
  return { root: SOUNDS_DIR, exists: fs.existsSync(SOUNDS_DIR), folders: list, total: list.reduce((n, f) => n + f.files.length, 0) };
}

app.get("/api/sounds", (req, res) => {
  res.json(listSounds());
});

// Пересканировать папку: панель получает свежий список, работающий бот — свежий набор звуков
app.post("/api/sounds/reload", async (req, res) => {
  const data = listSounds();
  let bot = null;
  if (isProcessRunning()) {
    try {
      const r = await fetch(`http://127.0.0.1:${runningBotPort || config.port || 3000}/api/sounds/reload`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
      bot = r.ok ? await r.json() : null;
    } catch {}
  }
  if (bot) broadcast({ type: "log", message: `[SOUNDS] Reloaded: ${bot.count} sound files` });
  res.json({ ...data, bot });
});

// Открыть папку звуков (или её подпапку) в проводнике. Путь проверяем: только внутри sounds.
app.post("/api/sounds/open", (req, res) => {
  const folder = typeof req.body?.folder === "string" ? req.body.folder : "";
  const target = path.resolve(SOUNDS_DIR, folder);
  if (target !== SOUNDS_DIR && !target.startsWith(SOUNDS_DIR + path.sep)) {
    res.status(400).json({ success: false, error: "Invalid folder" });
    return;
  }
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    // explorer.exe возвращает код 1 даже при успехе — результат не проверяем
    spawn("explorer.exe", [target], { detached: true, stdio: "ignore" }).unref();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Установленные в Windows шрифты — для выбора шрифта приветствия
app.get("/api/fonts", (req, res) => {
  try {
    res.json({ system: listSystemFonts() });
  } catch (err) {
    console.error("[FONTS] Failed to list system fonts:", err.message);
    res.json({ system: [] });
  }
});

app.get("/api/emotes", (req, res) => {
  const emotesPath = path.join(__dirname, "cache", "emote_names.json");
  if (fs.existsSync(emotesPath)) {
    try {
      const data = fs.readFileSync(emotesPath, "utf8");
      res.json(JSON.parse(data));
    } catch (err) {
      res.json({});
    }
  } else {
    res.json({});
  }
});

// Сообщаем панелям, когда бот пересохранил список эмоутов
const EMOTE_NAMES_PATH = path.join(__dirname, "cache", "emote_names.json");
fs.watchFile(EMOTE_NAMES_PATH, { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    broadcast({ type: "emotes-updated" });
  }
});

app.post("/api/restart", async (req, res) => {
  res.json({ success: true });
  if (isProcessRunning()) await restartBot();
  else startBot();
});

// ---- версия и обновления с GitHub (updates.js)
app.get("/api/version", (req, res) => {
  res.json({ version: updates.CURRENT, repo: updates.REPO, ...updates.installInfo(), lastUpdate: updates.lastResult() });
});

app.get("/api/update/check", async (req, res) => {
  try {
    res.json(await updates.check(req.query.force === "1"));
  } catch (err) {
    res.status(502).json({ success: false, error: err.message, current: updates.CURRENT });
  }
});

app.post("/api/update/install", async (req, res) => {
  try {
    const info = await updates.startInstall(broadcast, WEB_PORT);
    res.json({ success: true, version: info.latest });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---- эдит: состояние, источники OBS, тестовый запуск — у бота (edit.js)
async function proxyEdit(req, res, pathname, method = "GET") {
  if (!isProcessRunning()) {
    res.status(409).json({ success: false, botRunning: false, error: "Бот не запущен" });
    return;
  }
  try {
    const r = await botFetch(pathname, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: "Бот не ответил" });
  }
}
app.get("/api/edit/state", (req, res) => proxyEdit(req, res, "/api/edit/state"));
app.get("/api/edit/sources", (req, res) => proxyEdit(req, res, "/api/edit/sources"));
app.post("/api/edit/start", (req, res) => proxyEdit(req, res, "/api/edit/start", "POST"));
app.post("/api/edit/stop", (req, res) => proxyEdit(req, res, "/api/edit/stop", "POST"));
app.get("/api/reward/state", (req, res) => proxyEdit(req, res, "/api/reward/state"));
app.post("/api/reward/login", (req, res) => proxyEdit(req, res, "/api/reward/login", "POST"));
app.post("/api/reward/logout", (req, res) => proxyEdit(req, res, "/api/reward/logout", "POST"));

app.get("/api/status", (req, res) => {
  res.json({ 
    running: isProcessRunning(),
    pid: serverProcess ? serverProcess.pid : null
  });
});

app.post("/api/start", (req, res) => {
  if (isProcessRunning()) {
    res.json({ success: false, error: "Bot already running" });
    return;
  }

  startBot();
  res.json({ success: true });
});

app.post("/api/stop", async (req, res) => {
  if (!isProcessRunning()) {
    res.json({ success: false, error: "Bot not running" });
    return;
  }

  await stopBot();
  res.json({ success: true });
});

app.post("/api/reset-session", async (req, res) => {
  if (!isProcessRunning()) {
    res.status(400).json({ success: false, error: "Bot is not running" });
    return;
  }

  const botPort = runningBotPort || config.port || 3000;

  try {
    const response = await fetch(`http://127.0.0.1:${botPort}/api/session/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Bot API error: ${response.status}`);
    }

    const payload = await response.json();
    broadcast({ type: "log", message: `[SESSION] Reset via control panel (greetings: ${payload.greetedCount ?? 0})` });
    res.json({ success: true, ...payload });
  } catch (err) {
    console.error("[SESSION] Reset failed:", err.message);
    res.status(500).json({ success: false, error: "Failed to reset bot session" });
  }
});

// Время в играх ведёт бот — панель ходит к нему через эти прокси
async function proxyGame(req, res, pathname, options) {
  if (!isProcessRunning()) {
    res.status(503).json({ success: false, error: "Бот не запущен" });
    return;
  }
  try {
    const r = await botFetch(pathname, options);
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: "Бот не отвечает" });
  }
}

app.get("/api/game/state", (req, res) => proxyGame(req, res, "/api/game/state"));

app.post("/api/game/playtime/:id", (req, res) => proxyGame(req, res, `/api/game/playtime/${encodeURIComponent(req.params.id)}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ seconds: req.body?.seconds }),
}));

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[PROCESS] Shutting down...");
  if (serverProcess) {
    serverProcess.kill();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[PROCESS] Shutting down...");
  if (serverProcess) {
    serverProcess.kill();
  }
  process.exit(0);
});

// Инициализация
loadConfig();

// Открываем браузер
function openBrowser(url) {
  const start = process.platform === 'darwin' ? 'open' : 
                process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${start} ${url}`);
}

// Автооткрытие браузера через 1 секунду
setTimeout(() => {
  console.log("[BROWSER] Opening web interface...");
  if (!process.env.NO_BROWSER) openBrowser(`http://localhost:${WEB_PORT}`);
}, 1000);

// Автозапуск бота через 2 секунды после старта веб-панели
setTimeout(() => {
  console.log("[AUTOSTART] Starting bot automatically...");
  startBot();
}, 2000);
