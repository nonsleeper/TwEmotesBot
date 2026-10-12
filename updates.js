// Обновления с GitHub Releases: проверка последней версии, скачивание архива и запуск updater.ps1.
// Репозиторий берётся из package.json -> emotesBot.updateRepo ("owner/name"); пусто — проверка выключена.
// Архив релиза: EmotesBot-v<версия>.zip (его собирает tray\publish-release.ps1).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const pkg = require("./package.json");
const CURRENT = pkg.version;
const REPO = process.env.UPDATE_REPO || (pkg.emotesBot && pkg.emotesBot.updateRepo) || "";
const ASSET_RE = /^EmotesBot-v[\d.]+.*\.zip$/i;
const CHECK_TTL_MS = 60 * 60 * 1000; // GitHub без токена — 60 запросов в час на IP, поэтому кэшируем
const RESULT_FILE = path.join(__dirname, ".update-result.json");
const HEADERS = { "User-Agent": "EmotesBot-updater", Accept: "application/vnd.github+json" };

let cached = null;
let installing = false;

function parseVersion(v) {
  return String(v || "").replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
}

function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Установить само можно, только если панель запущена треем из релизной папки (exe\app\web-server.js)
function installInfo() {
  const dir = process.env.INSTALL_DIR;
  const ok = Boolean(
    dir && process.env.TRAY_PID &&
    path.resolve(dir, "app").toLowerCase() === path.resolve(__dirname).toLowerCase() &&
    fs.existsSync(path.join(dir, "EmotesBotTray.exe"))
  );
  return { canInstall: ok, installDir: ok ? dir : null };
}

async function check(force = false) {
  if (!REPO) return { enabled: false, current: CURRENT };
  if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) return cached.data;

  // UPDATE_API_BASE — подмена адреса GitHub API для проверок (локальный тестовый сервер)
  const apiBase = process.env.UPDATE_API_BASE || "https://api.github.com";
  const res = await fetch(`${apiBase}/repos/${REPO}/releases/latest`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  let data;
  if (res.status === 404) {
    data = { enabled: true, repo: REPO, current: CURRENT, latest: null, hasUpdate: false }; // релизов ещё нет
  } else if (!res.ok) {
    throw new Error(`GitHub ответил HTTP ${res.status}`);
  } else {
    const rel = await res.json();
    const asset = (rel.assets || []).find(a => ASSET_RE.test(a.name));
    const latest = String(rel.tag_name || "").replace(/^v/i, "");
    data = {
      enabled: true,
      repo: REPO,
      current: CURRENT,
      latest,
      hasUpdate: isNewer(latest, CURRENT),
      name: rel.name || `v${latest}`,
      notes: rel.body || "",
      publishedAt: rel.published_at,
      htmlUrl: rel.html_url,
      asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
      ...installInfo(),
    };
  }
  cached = { at: Date.now(), data };
  return data;
}

async function download(url, expectedSize, dest, onProgress) {
  const res = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"] }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`Не удалось скачать архив: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || expectedSize || 0;
  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      received += chunk.length;
      if (Date.now() - lastReport > 250) { lastReport = Date.now(); onProgress(received, total); }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  onProgress(received, total);

  if (expectedSize && received !== expectedSize) throw new Error(`Архив скачался не полностью (${received} из ${expectedSize} байт)`);
  const head = Buffer.alloc(2);
  const fd = fs.openSync(dest, "r");
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "PK") throw new Error("Скачанный файл — не zip-архив");
}

// Запускает установку в фоне; ход и ошибки — через broadcast ({ type: "update-progress" | "update-installing" | "update-error" })
async function startInstall(broadcast, panelPort) {
  if (installing) throw new Error("Обновление уже устанавливается");
  const info = await check(true);
  if (!info.hasUpdate) throw new Error("У вас уже последняя версия");
  if (!info.asset) throw new Error("В релизе на GitHub нет архива для установки");
  if (!info.canInstall) throw new Error("Само обновиться может только версия с треем (EmotesBotTray.exe). Скачайте архив со страницы релиза.");
  installing = true;

  (async () => {
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emotesbot-update-"));
      const zip = path.join(tmp, info.asset.name);
      console.log(`[UPDATE] Downloading ${info.asset.name} (${info.asset.size} bytes)`);
      await download(info.asset.url, info.asset.size, zip, (received, total) =>
        broadcast({ type: "update-progress", received, total, version: info.latest }));

      // скрипт копируем во временную папку: сам app\ во время обновления заменяется
      const script = path.join(tmp, "updater.ps1");
      fs.copyFileSync(path.join(__dirname, "updater.ps1"), script);

      console.log(`[UPDATE] Installing v${info.latest}, the panel will restart`);
      broadcast({ type: "update-installing", version: info.latest });
      // Установщик должен пережить остановку панели. Отсоединённый процесс Node.js запускает без консоли,
      // а Windows PowerShell без консоли сразу закрывается, — поэтому через `cmd /c start`: он даёт
      // PowerShell собственную (скрытую) консоль и не связывает его с панелью.
      const q = (s) => `"${String(s).replace(/"/g, "")}"`;
      const args = [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", q(script),
        "-Zip", q(zip), "-InstallDir", q(info.installDir), "-TrayPid", String(Number(process.env.TRAY_PID) || 0),
        "-PanelPort", String(Number(panelPort) || 3001), "-FromVersion", q(CURRENT), "-ToVersion", q(info.latest),
      ].join(" ");
      const child = spawn(process.env.ComSpec || "cmd.exe", [`/d /s /c "start "" /min powershell.exe ${args}"`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      });
      child.unref();
    } catch (err) {
      installing = false;
      console.error("[UPDATE] Failed:", err.message);
      broadcast({ type: "update-error", error: err.message });
    }
  })();

  return info;
}

// Итог последнего обновления (пишет updater.ps1) — отдаём, пока он свежий (10 минут).
// Не удаляем: его читают и трей, и каждая открытая панель; панель сама помнит, что уже показала его (по полю at).
function lastResult() {
  try {
    if (Date.now() - fs.statSync(RESULT_FILE).mtimeMs > 10 * 60 * 1000) return null;
    return JSON.parse(fs.readFileSync(RESULT_FILE, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

module.exports = { CURRENT, REPO, check, startInstall, installInfo, lastResult, isNewer };
