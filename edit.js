// «Эдит» на вебке: под бит музыки бот дёргает источник камеры в OBS (зум, тряска, наклон — через обрезку,
// масштаб и поворот элемента сцены; вспышки, цвет, моно — через фильтр «Коррекция цвета») и бросает эмоуты
// из чата на вебку (оверлей edit.html). Биты — по уровню громкости выбранного аудиоисточника OBS.
// Всё через встроенный в OBS сервер WebSocket (obs.js), плагины не нужны.
const fs = require("fs");
const path = require("path");
const { ObsClient } = require("./obs");

const FILTER_NAME = "TwEmotesBot: эдит";
const NEUTRAL_COLOR = { hue_shift: 0, saturation: 0, contrast: 0, brightness: 0 };
const FRAME_MS = 33; // ~30 кадров в секунду в OBS
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// fs.rmSync в Node 24 на Windows молча ничего не делает, если в пути есть кириллица (папка «Новая папка» и т.п.),
// поэтому удаляем через unlinkSync
function removeFile(file) {
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

// ---------------------------------------------------------------- биты

// Уровни громкости приходят из OBS ~20 раз в секунду. Ищем удары (резкий рост уровня), по ним — темп и фазу
// сетки битов, и дальше предсказываем удары по сетке (как beat_grid в офлайн-рендере), а не ждём каждый —
// так эффект попадает в бит несмотря на редкие данные и задержку.
class BeatTracker {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.onsets = [];
    this.onsetCount = 0;
    this.prev = 0;
    this.lastOnset = -1e9;
    this.lastLoud = -1e9;
    this.period = 0;
    this.phase = 0;
    this.locked = false;
    this.level = 0;
  }

  push(level, t) {
    this.level = level;
    const flux = Math.max(0, level - this.prev);
    this.prev = level;
    this.samples.push({ t, level, flux });
    while (this.samples.length && t - this.samples[0].t > 3000) this.samples.shift();
    if (level > 0.015) this.lastLoud = t;
    if (this.samples.length < 10) return;

    const n = this.samples.length;
    const meanFlux = this.samples.reduce((s, x) => s + x.flux, 0) / n;
    const sdFlux = Math.sqrt(this.samples.reduce((s, x) => s + (x.flux - meanFlux) ** 2, 0) / n);
    const meanLevel = this.samples.reduce((s, x) => s + x.level, 0) / n;
    if (flux > meanFlux + 1.4 * sdFlux && flux > 0.015 && level > meanLevel * 1.05 && t - this.lastOnset > 240) {
      this.lastOnset = t;
      this.onsetCount++;
      this.onsets.push(t);
      while (this.onsets.length && t - this.onsets[0] > 12000) this.onsets.shift();
      this.estimate(t);
    }
  }

  // Темп: период (80–180 BPM), под который лучше всего ложатся интервалы между ударами; фаза — сдвиг сетки
  estimate(now) {
    const o = this.onsets;
    if (o.length < 5) { this.locked = false; return; }
    let bestP = 0;
    let bestScore = -1;
    for (let P = 333; P <= 750; P += 4) {
      let score = 0;
      for (let i = 0; i < o.length; i++) {
        for (let j = i + 1; j < o.length && o[j] - o[i] < 4000; j++) {
          const gap = o[j] - o[i];
          const k = Math.round(gap / P);
          if (k < 1) continue;
          const err = gap - k * P;
          score += Math.exp(-(err * err) / (2 * 35 * 35)) / Math.sqrt(k);
        }
      }
      if (this.period && Math.abs(P - this.period) < 12) score *= 1.15; // держимся прежнего темпа
      if (score > bestScore) { bestScore = score; bestP = P; }
    }

    let bestPhase = 0;
    let bestFit = -1;
    for (let phi = 0; phi < bestP; phi += 4) {
      let fit = 0;
      for (const t of o) {
        let d = (t - phi) % bestP;
        if (d < 0) d += bestP;
        d = Math.min(d, bestP - d);
        fit += Math.exp(-(d * d) / (2 * 30 * 30)) * (1 + (t - o[0]) / 6000); // свежие удары важнее
      }
      if (fit > bestFit) { bestFit = fit; bestPhase = phi; }
    }

    const recent = o.filter(t => now - t < 8000);
    const onGrid = recent.filter(t => {
      let d = (t - bestPhase) % bestP;
      if (d < 0) d += bestP;
      return Math.min(d, bestP - d) < 60;
    }).length;
    this.period = bestP;
    this.phase = bestPhase;
    this.locked = recent.length >= 5 && onGrid / recent.length >= 0.55;
  }

  // Где мы относительно битов в момент t: index — номер бита, u — доля пути до следующего (0..1)
  position(t) {
    if (t - this.lastLoud > 1500) return null; // тишина — эффектов нет
    if (this.locked && this.period) {
      const k = Math.floor((t - this.phase) / this.period);
      return { index: `g${k}`, u: (t - this.phase - k * this.period) / this.period, period: this.period, bpm: 60000 / this.period, locked: true };
    }
    if (!this.onsets.length) return null;
    const last = this.onsets[this.onsets.length - 1];
    const gaps = this.onsets.slice(-8).map((t, i, a) => (i ? t - a[i - 1] : 0)).filter(g => g > 0).sort((a, b) => a - b);
    const period = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 500;
    return { index: `o${this.onsetCount}`, u: (t - last) / period, period, bpm: 60000 / period, locked: false };
  }
}

// ---------------------------------------------------------------- эффекты

// u — доля пути от бита до следующего (0..1), d — направление (±1). Значения — как в motion() офлайн-рендера,
// но без того, что встроенный OBS не умеет (RGB-сдвиг, глитч, блюр). ox/oy — доля кадра, tilt — градусы,
// hue — градусы, sat/contrast — множители (1 = как есть), bright — добавка яркости (-1..1).
const ex = Math.exp;
const EFFECTS = {
  punch: (u) => ({ zoom: 1 + 0.32 * ex(-u * 7), ox: Math.sin(u * 48) * 0.012 * ex(-u * 4), oy: Math.cos(u * 32) * 0.008 * ex(-u * 4) }),
  smash: (u, d) => ({
    zoom: 1.12 + 0.55 * ex(-u * 9),
    ox: Math.sin(u * 54) * 0.03 * ex(-u * 5), oy: Math.cos(u * 40) * 0.02 * ex(-u * 5),
    tilt: d * 5 * Math.sin(u * Math.PI) * ex(-u * 3), bright: u < 0.06 ? 0.75 : 0, contrast: 1.2,
  }),
  shake: (u) => ({
    zoom: 1.12 + 0.1 * Math.sin(u * Math.PI),
    ox: Math.sin(u * 56) * 0.028 * (1 - u * 0.35), oy: Math.cos(u * 44) * 0.018 * (1 - u * 0.35), tilt: 2 * Math.sin(u * 18),
  }),
  tilt: (u, d) => ({ zoom: 1.12, tilt: d * 7 * Math.sin(u * Math.PI) }),
  flash: (u) => ({ zoom: 1.1 + 0.35 * ex(-u * 8), ox: Math.sin(u * 36) * 0.01 * (1 - u), bright: u < 0.06 ? 0.85 : u < 0.14 ? 0.3 : 0 }),
  hue: (u, d) => ({ zoom: 1.08 + 0.25 * ex(-u * 6), hue: d * (80 + 200 * u), sat: 1.55 }),
  mono: (u) => ({ zoom: 1.15 + 0.25 * ex(-u * 7), sat: 0, contrast: 1.6 }),
  strobe: (u) => ({ zoom: 1.12, bright: Math.floor(u * 8) % 2 ? 0.55 : 0 }),
  zoomspin: (u, d) => ({ zoom: 1.1 + 0.4 * Math.abs(Math.sin(u * Math.PI)), tilt: d * 14 * Math.sin(u * Math.PI * 2) }),
};
const EFFECT_KEYS = Object.keys(EFFECTS);

// Сила эффектов (100% = как в пресете): масштабируем отклонение от «как есть»
function scaleLook(look, k) {
  return {
    zoom: 1 + ((look.zoom || 1) - 1) * k,
    ox: (look.ox || 0) * k,
    oy: (look.oy || 0) * k,
    tilt: (look.tilt || 0) * k,
    hue: (look.hue || 0) * k,
    sat: 1 + ((look.sat ?? 1) - 1) * k,
    contrast: 1 + ((look.contrast ?? 1) - 1) * k,
    bright: (look.bright || 0) * k,
  };
}

// Эффект → настройки элемента сцены. Зум и тряска — через обрезку (кадр «наезжает» внутри той же рамки:
// масштаб растёт ровно настолько, насколько уменьшилась видимая часть), наклон — поворот вокруг центра рамки.
function buildTransform(T, look) {
  const W = T.sourceWidth;
  const H = T.sourceHeight;
  if (!W || !H) return null;
  const cL = T.cropLeft || 0, cR = T.cropRight || 0, cT = T.cropTop || 0, cB = T.cropBottom || 0;
  const w0 = W - cL - cR;
  const h0 = H - cT - cB;
  const z = Math.max(1, look.zoom);
  const w = w0 / z;
  const h = h0 / z;
  const cx = clamp(cL + w0 / 2 + look.ox * w0, cL + w / 2, W - cR - w / 2);
  const cy = clamp(cT + h0 / 2 + look.oy * h0, cT + h / 2, H - cB - h / 2);
  const out = {
    cropLeft: Math.round(cx - w / 2),
    cropRight: Math.round(W - (cx + w / 2)),
    cropTop: Math.round(cy - h / 2),
    cropBottom: Math.round(H - (cy + h / 2)),
  };
  const bounded = T.boundsType && T.boundsType !== "OBS_BOUNDS_NONE";
  let Dw, Dh;
  if (bounded) {
    Dw = T.boundsWidth;
    Dh = T.boundsHeight; // в рамке OBS сам растягивает обрезанное до прежнего размера
  } else {
    out.scaleX = T.scaleX * (w0 / (W - out.cropLeft - out.cropRight));
    out.scaleY = T.scaleY * (h0 / (H - out.cropTop - out.cropBottom));
    Dw = w0 * T.scaleX;
    Dh = h0 * T.scaleY;
  }
  const geo = centerOf(T, Dw, Dh);
  const rotation = T.rotation + (look.tilt || 0);
  const r = (rotation * Math.PI) / 180;
  out.rotation = rotation;
  out.positionX = geo.cx - (geo.vx * Math.cos(r) - geo.vy * Math.sin(r));
  out.positionY = geo.cy - (geo.vx * Math.sin(r) + geo.vy * Math.cos(r));
  return out;
}

// Центр рамки элемента на холсте: позиция элемента — это его точка привязки (alignment), от неё до центра — вектор v
function centerOf(T, Dw, Dh) {
  const al = T.alignment ?? 5; // 1 — слева, 2 — справа, 4 — сверху, 8 — снизу, 0 — по центру
  const ax = al & 1 ? 0 : al & 2 ? Dw : Dw / 2;
  const ay = al & 4 ? 0 : al & 8 ? Dh : Dh / 2;
  const vx = Dw / 2 - ax;
  const vy = Dh / 2 - ay;
  const r0 = (T.rotation * Math.PI) / 180;
  return {
    vx, vy, w: Math.abs(Dw), h: Math.abs(Dh),
    cx: T.positionX + vx * Math.cos(r0) - vy * Math.sin(r0),
    cy: T.positionY + vx * Math.sin(r0) + vy * Math.cos(r0),
  };
}

function colorSettings(look) {
  let hue = ((look.hue % 360) + 540) % 360 - 180;
  return {
    hue_shift: Math.round(hue * 10) / 10,
    saturation: Math.round(clamp(look.sat - 1, -1, 5) * 1000) / 1000,
    contrast: Math.round(clamp((look.contrast - 1) * 1.5, -4, 4) * 1000) / 1000,
    brightness: Math.round(clamp(look.bright, -1, 1) * 1000) / 1000,
  };
}

// ---------------------------------------------------------------- сеанс эдита

class EditController {
  constructor({ dataDir, log = console.log, overlay = () => {}, emotePool = () => [] }) {
    this.log = log;
    this.overlay = overlay;
    this.emotePool = emotePool;
    this.restoreFile = path.join(dataDir, "edit-restore.json");
    this.obs = new ObsClient();
    this.tracker = new BeatTracker();
    this.cfg = null;
    this.session = null;
    this.cooldownUntil = 0;
    this.busy = false;
    this.lastLevelAt = 0;

    this.obs.on("ready", () => {
      this.log("[EDIT] Connected to OBS");
      this.restoreAfterCrash().catch(err => this.log(`[EDIT] Restore failed: ${err.message}`));
    });
    this.obs.on("disconnected", (why) => {
      this.log(`[EDIT] OBS disconnected: ${why}`);
      if (this.session) this.endSession("OBS отключился", { restore: false });
    });
    this.obs.on("meters", (inputs) => this.onMeters(inputs));
  }

  applyConfig(cfg) {
    this.cfg = {
      enabled: cfg.editEnabled === true,
      camera: cfg.editCameraSource || "",
      audio: cfg.editAudioSource || "",
      duration: clamp(Number(cfg.editDuration) || 30, 5, 600),
      cooldown: clamp(Number(cfg.editCooldown) || 0, 0, 3600),
      intensity: clamp((Number(cfg.editIntensity) || 100) / 100, 0.1, 2.5),
      effects: (Array.isArray(cfg.editEffects) ? cfg.editEffects : EFFECT_KEYS).filter(k => EFFECTS[k]),
      emotes: cfg.editEmotes !== false,
      latency: clamp(Number(cfg.editLatencyMs) || 0, 0, 500),
    };
    if (!this.cfg.effects.length) this.cfg.effects = ["punch"];
    if (this.cfg.enabled) this.obs.configure({ host: cfg.obsHost, port: cfg.obsPort, password: cfg.obsPassword });
    else this.obs.disconnect();
  }

  state() {
    const now = Date.now();
    const pos = this.tracker.position(now + (this.cfg ? this.cfg.latency : 0));
    return {
      enabled: Boolean(this.cfg && this.cfg.enabled),
      obs: this.obs.status(),
      running: Boolean(this.session),
      remaining: this.session ? Math.max(0, Math.ceil((this.session.endsAt - now) / 1000)) : 0,
      cooldown: Math.max(0, Math.ceil((this.cooldownUntil - now) / 1000)),
      level: this.lastLevelAt && now - this.lastLevelAt < 1000 ? Math.round(this.tracker.level * 1000) / 1000 : null,
      bpm: pos ? Math.round(pos.bpm) : null,
      locked: pos ? pos.locked : false,
      beatPhase: pos ? Math.min(1, pos.u) : null,
      effects: EFFECT_KEYS,
    };
  }

  onMeters(inputs) {
    if (!this.cfg || !this.cfg.audio) return;
    const input = inputs.find(i => i.inputName === this.cfg.audio);
    if (!input) return;
    // inputLevelsMul: [[magnitude, peak, inputPeak], ...] по каналам; пик лучше видит удары
    let level = 0;
    for (const ch of input.inputLevelsMul || []) level = Math.max(level, ch[1] || 0);
    this.lastLevelAt = Date.now();
    this.tracker.push(level, this.lastLevelAt);
  }

  // Список источников OBS для панели
  async sources() {
    const { inputs } = await this.obs.request("GetInputList");
    const video = [];
    const audio = [];
    for (const i of inputs) {
      const kind = i.inputKind || "";
      if (/wasapi|pulse|coreaudio|jack|alsa/.test(kind)) audio.push({ name: i.inputName, kind });
      else video.push({ name: i.inputName, kind });
    }
    // у видеоисточников тоже бывает звук (медиа, браузер) — даём выбрать и их
    return { video, audio: [...audio, ...video.filter(v => /ffmpeg|vlc|browser|game_capture|window_capture|dshow/.test(v.kind))] };
  }

  // Элемент сцены с камерой: в текущей сцене, в группах и вложенных сценах (до 3 уровней)
  async findCameraItem() {
    const { currentProgramSceneName } = await this.obs.request("GetCurrentProgramScene");
    const seen = new Set();
    const search = async (sceneName, isGroup, depth) => {
      if (depth > 3 || seen.has(sceneName)) return null;
      seen.add(sceneName);
      const { sceneItems } = await this.obs.request(isGroup ? "GetGroupSceneItemList" : "GetSceneItemList", { sceneName });
      const direct = sceneItems.find(it => it.sourceName === this.cfg.camera);
      if (direct) return { sceneName, sceneItemId: direct.sceneItemId };
      for (const it of sceneItems) {
        if (it.isGroup || it.sourceType === "OBS_SOURCE_TYPE_SCENE") {
          const found = await search(it.sourceName, Boolean(it.isGroup), depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return search(currentProgramSceneName, false, 0);
  }

  async ensureFilter() {
    try {
      await this.obs.request("GetSourceFilter", { sourceName: this.cfg.camera, filterName: FILTER_NAME });
    } catch (err) {
      if (err.code !== 600) throw err; // 600 — ResourceNotFound: фильтра ещё нет
      await this.obs.request("CreateSourceFilter", {
        sourceName: this.cfg.camera, filterName: FILTER_NAME, filterKind: "color_filter_v2", filterSettings: NEUTRAL_COLOR,
      });
      this.log(`[EDIT] Added color filter "${FILTER_NAME}" to "${this.cfg.camera}"`);
    }
  }

  // Старт по команде (проверяет паузу) или из панели (force — без паузы)
  async start({ by = "", duration, force = false } = {}) {
    if (!this.cfg || !this.cfg.enabled) throw new Error("Эдит выключен в настройках");
    if (!this.cfg.camera) throw new Error("Не выбран источник камеры");
    if (!this.obs.status().connected) throw new Error(this.obs.status().error || "Нет связи с OBS");
    if (this.session) {
      this.session.endsAt = Date.now() + (duration || this.cfg.duration) * 1000; // повторная команда продлевает
      return { extended: true };
    }
    if (!force && Date.now() < this.cooldownUntil) {
      throw new Error(`Эдит отдыхает ещё ${Math.ceil((this.cooldownUntil - Date.now()) / 1000)} с`);
    }

    const item = await this.findCameraItem();
    if (!item) throw new Error(`Источника «${this.cfg.camera}» нет в текущей сцене OBS`);
    const { sceneItemTransform: T } = await this.obs.request("GetSceneItemTransform", item);
    const original = {
      positionX: T.positionX, positionY: T.positionY, rotation: T.rotation, scaleX: T.scaleX, scaleY: T.scaleY,
      cropLeft: T.cropLeft, cropRight: T.cropRight, cropTop: T.cropTop, cropBottom: T.cropBottom,
    };
    // если бот упадёт посреди эдита — при следующем подключении вернём как было
    fs.writeFileSync(this.restoreFile, JSON.stringify({ ...item, original }), "utf8");
    await this.ensureFilter();
    await this.obs.request("SetSourceFilterEnabled", { sourceName: this.cfg.camera, filterName: FILTER_NAME, filterEnabled: true });

    let canvas = { w: 1920, h: 1080 };
    try {
      const v = await this.obs.request("GetVideoSettings");
      canvas = { w: v.baseWidth, h: v.baseHeight };
    } catch {}
    const bounded = T.boundsType && T.boundsType !== "OBS_BOUNDS_NONE";
    const geo = centerOf(T, bounded ? T.boundsWidth : (T.sourceWidth - T.cropLeft - T.cropRight) * T.scaleX,
      bounded ? T.boundsHeight : (T.sourceHeight - T.cropTop - T.cropBottom) * T.scaleY);

    this.session = {
      item, T, original, by,
      startedAt: Date.now(),
      endsAt: Date.now() + (duration || this.cfg.duration) * 1000,
      beat: null, effect: "punch", dir: 1, lastColor: null, chatTriggered: !force,
    };
    this.overlay({ type: "edit-start", canvas, rect: { cx: geo.cx, cy: geo.cy, w: geo.w, h: geo.h, rotation: T.rotation } });
    this.timer = setInterval(() => this.frame(), FRAME_MS);
    this.log(`[EDIT] Started${by ? ` by ${by}` : ""} for ${Math.round((this.session.endsAt - Date.now()) / 1000)}s on "${this.cfg.camera}"`);
    return { started: true };
  }

  async stop(reason = "остановлен") {
    if (!this.session) return { stopped: false };
    await this.endSession(reason, { restore: true });
    return { stopped: true };
  }

  async endSession(reason, { restore }) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(this.timer);
    this.overlay({ type: "edit-end" });
    if (s.chatTriggered) this.cooldownUntil = Date.now() + this.cfg.cooldown * 1000;
    if (restore) {
      try {
        await this.obs.batch([
          { requestType: "SetSceneItemTransform", requestData: { ...s.item, sceneItemTransform: s.original } },
          { requestType: "SetSourceFilterSettings", requestData: { sourceName: this.cfg.camera, filterName: FILTER_NAME, filterSettings: NEUTRAL_COLOR, overlay: true } },
          { requestType: "SetSourceFilterEnabled", requestData: { sourceName: this.cfg.camera, filterName: FILTER_NAME, filterEnabled: false } },
        ]);
        removeFile(this.restoreFile);
      } catch (err) {
        this.log(`[EDIT] Could not restore the camera now (${err.message}) — will retry on the next connection`);
      }
    }
    this.log(`[EDIT] Ended: ${reason}`);
  }

  async restoreAfterCrash() {
    if (!fs.existsSync(this.restoreFile) || this.session) return;
    const saved = JSON.parse(fs.readFileSync(this.restoreFile, "utf8"));
    await this.obs.request("SetSceneItemTransform", { sceneName: saved.sceneName, sceneItemId: saved.sceneItemId, sceneItemTransform: saved.original });
    if (this.cfg && this.cfg.camera) {
      await this.obs.request("SetSourceFilterEnabled", { sourceName: this.cfg.camera, filterName: FILTER_NAME, filterEnabled: false }).catch(() => {});
    }
    removeFile(this.restoreFile);
    this.log("[EDIT] Camera position restored after an interrupted edit");
  }

  frame() {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    if (now >= s.endsAt) { this.endSession("время вышло", { restore: true }); return; }
    if (this.busy) return; // OBS ещё не ответил на прошлый кадр — пропускаем, чтобы не копить очередь

    const pos = this.tracker.position(now + this.cfg.latency);
    if (pos && pos.index !== s.beat) {
      s.beat = pos.index;
      const pool = this.cfg.effects.length > 1 ? this.cfg.effects.filter(e => e !== s.effect) : this.cfg.effects;
      s.effect = pool[Math.floor(Math.random() * pool.length)];
      s.dir = Math.random() < 0.5 ? -1 : 1;
      if (this.cfg.emotes) {
        const emotes = this.emotePool();
        if (emotes.length) this.overlay({ type: "edit-beat", period: pos.period, emotes: emotes.slice(0, 3), effect: s.effect });
      }
    }

    // между битами (и в тишине) эффект затухает; поверх — лёгкий «дрейф», как в рендере
    const u = pos ? pos.u : 2;
    const base = u <= 1.15 ? EFFECTS[s.effect](Math.min(u, 1), s.dir) : { zoom: 1.04 };
    const t = (now - s.startedAt) / 1000;
    base.zoom = Math.max(base.zoom || 1, 1.04);
    base.ox = (base.ox || 0) + Math.sin(t * 2.4) * 0.004;
    base.oy = (base.oy || 0) + Math.cos(t * 1.7) * 0.003;
    const look = scaleLook(base, this.cfg.intensity);

    const transform = buildTransform(s.T, look);
    const requests = [];
    if (transform) requests.push({ requestType: "SetSceneItemTransform", requestData: { ...s.item, sceneItemTransform: transform } });
    const color = colorSettings(look);
    if (!s.lastColor || Object.keys(color).some(k => Math.abs(color[k] - s.lastColor[k]) > 0.004)) {
      s.lastColor = color;
      requests.push({ requestType: "SetSourceFilterSettings", requestData: { sourceName: this.cfg.camera, filterName: FILTER_NAME, filterSettings: color, overlay: true } });
    }
    if (!requests.length) return;
    this.busy = true;
    this.obs.batch(requests).catch(() => {}).finally(() => { this.busy = false; });
  }

  // При выключении бота: вернуть камеру и дождаться ответа OBS (не дольше timeoutMs)
  async shutdown(timeoutMs = 1500) {
    if (this.session) {
      await Promise.race([this.endSession("бот выключается", { restore: true }), new Promise(r => setTimeout(r, timeoutMs))]);
    }
    this.obs.disconnect();
  }
}

module.exports = { EditController, BeatTracker, EFFECT_KEYS, buildTransform, centerOf, colorSettings, scaleLook, EFFECTS };
