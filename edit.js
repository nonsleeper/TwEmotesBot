// «Эдит» на вебке: под бит музыки бот дёргает источник камеры в OBS (зум, тряска, наклон, вращение, отражение —
// через обрезку, масштаб и поворот элемента сцены; цвет, вспышки, подкраска, мерцание — фильтром «Коррекция цвета»;
// инверт, постер, тепловизор и другие — фильтром «Применить LUT» со сгенерированными таблицами; резкость — «Резкость»)
// и бросает эмоуты из чата в оверлей эмоутов. Биты — по уровню громкости выбранного аудиоисточника OBS.
// Всё через встроенный в OBS сервер WebSocket (obs.js), плагины не нужны.
const fs = require("fs");
const path = require("path");
const { ObsClient } = require("./obs");

const FILTER_NAME = "TwEmotesBot: эдит";
const NEUTRAL_COLOR = { hue_shift: 0, saturation: 0, contrast: 0, brightness: 0, opacity: 1, color_multiply: 0xffffffff };
// Фильтры, которые бот вешает на камеру (встроенные в OBS) и включает только на время эдита
const FILTERS = {
  color: { name: FILTER_NAME, kind: "color_filter_v2", neutral: NEUTRAL_COLOR },
  lut: { name: "TwEmotesBot: LUT", kind: "clut_filter", neutral: { clut_amount: 0 } },
  sharp: { name: "TwEmotesBot: резкость", kind: "sharpness_filter_v2", neutral: { sharpness: 0 } },
};
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
// Сетке не верим вслепую: в тишине (конец трека, пауза) биты прекращаются и сетка сбрасывается, а если удары
// перестали в неё попадать (сменился темп, трек без паузы) — она снимается. Пока сетки нет, биты идут прямо
// по скачкам громкости.
const SILENCE_ABS = 0.02;      // почти ноль — тишина в любом случае
const SILENCE_REL = 0.12;      // или тише 12% от обычной громкости этой музыки (затухание в конце трека)
const SILENCE_STOP_MS = 350;   // через столько тишины биты прекращаются
const SILENCE_RESET_MS = 1200; // ...а через столько сетка забывается — новый трек считается с нуля
const ONSET_WINDOW_MS = 8000;  // по скольким последним ударам считаем темп

class BeatTracker {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.onsets = [];
    this.onsetCount = 0;
    this.prev = 0;
    this.lastOnset = -1e9;
    this.quietSince = 0; // с какого момента тихо (null — звучит)
    this.loudRef = 0;    // обычная громкость музыки, медленное среднее за ~10 с
    this.period = 0;
    this.phase = 0;
    this.locked = false;
    this.level = 0;
  }

  dropGrid() {
    this.onsets = [];
    this.period = 0;
    this.locked = false;
  }

  isQuiet(level) {
    return level < SILENCE_ABS || (this.loudRef > 0 && level < this.loudRef * SILENCE_REL);
  }

  push(level, t) {
    this.level = level;
    if (level >= SILENCE_ABS) this.loudRef = this.loudRef ? this.loudRef * 0.995 + level * 0.005 : level;

    const quiet = this.isQuiet(level);
    if (quiet) {
      if (this.quietSince === null) this.quietSince = t;
      if (t - this.quietSince > SILENCE_RESET_MS && (this.onsets.length || this.locked)) this.dropGrid();
    } else {
      this.quietSince = null;
    }

    const flux = Math.max(0, level - this.prev);
    this.prev = level;
    this.samples.push({ t, level, flux });
    while (this.samples.length && t - this.samples[0].t > 3000) this.samples.shift();

    // удары перестали приходить (тихая часть, пропала бочка) — сетку снимаем, а не стучим по памяти
    if (this.locked && t - this.lastOnset > Math.max(this.period * 4, 1600)) this.locked = false;

    if (quiet || this.samples.length < 10) return;
    const n = this.samples.length;
    const meanFlux = this.samples.reduce((s, x) => s + x.flux, 0) / n;
    const sdFlux = Math.sqrt(this.samples.reduce((s, x) => s + (x.flux - meanFlux) ** 2, 0) / n);
    const meanLevel = this.samples.reduce((s, x) => s + x.level, 0) / n;
    if (flux > meanFlux + 1.4 * sdFlux && flux > 0.015 && level > meanLevel * 1.05 && t - this.lastOnset > 240) {
      this.lastOnset = t;
      this.onsetCount++;
      this.onsets.push(t);
      while (this.onsets.length && t - this.onsets[0] > ONSET_WINDOW_MS) this.onsets.shift();
      this.estimate(t);
    }
  }

  // доля ударов, попавших в сетку (не дальше tolerance мс от её бита)
  onGridShare(times, period, phase, tolerance = 60) {
    if (!times.length) return 0;
    return times.filter(t => {
      let d = (t - phase) % period;
      if (d < 0) d += period;
      return Math.min(d, period - d) < tolerance;
    }).length / times.length;
  }

  // Темп: период (80–180 BPM), под который лучше всего ложатся интервалы между ударами; фаза — сдвиг сетки
  estimate(now) {
    // свежие удары не ложатся в нынешнюю сетку — скорее всего, другой трек: старые удары забываем
    if (this.locked) {
      // строже, чем при поиске: у близких темпов (96 и 128) часть ударов совпадает случайно
      const fresh = this.onsets.filter(t => now - t < 2500);
      if (fresh.length >= 3 && this.onGridShare(fresh, this.period, this.phase, 40) < 0.6) {
        this.onsets = fresh;
        this.period = 0;
        this.locked = false;
      }
    }

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

    this.period = bestP;
    this.phase = bestPhase;
    this.locked = o.length >= 5 && this.onGridShare(o, bestP, bestPhase) >= 0.55;
  }

  // Где мы относительно битов в момент t: index — номер бита, u — доля пути до следующего (0..1)
  position(t) {
    if (this.quietSince !== null && t - this.quietSince > SILENCE_STOP_MS) return null; // тишина — эффектов нет
    if (this.locked && this.period) {
      const k = Math.floor((t - this.phase) / this.period);
      return { index: `g${k}`, u: (t - this.phase - k * this.period) / this.period, period: this.period, bpm: 60000 / this.period, locked: true };
    }
    // сетки нет — бит прямо по скачкам громкости
    if (!this.onsets.length) return null;
    const last = this.onsets[this.onsets.length - 1];
    const gaps = this.onsets.slice(-8).map((x, i, a) => (i ? x - a[i - 1] : 0)).filter(g => g > 0).sort((a, b) => a - b);
    const period = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 500;
    return { index: `o${this.onsetCount}`, u: (t - last) / period, period, bpm: 60000 / period, locked: false };
  }
}

// ---------------------------------------------------------------- эффекты

// u — доля пути от бита до следующего (0..1), d — направление (±1), rnd(i) — случайное 0..1, своё на каждый бит
// (одинаковое для одного i в пределах бита). ox/oy — доля кадра, tilt — градусы, spin — градусы (без учёта силы),
// hue — градусы, sat/contrast — множители (1 = как есть), bright — добавка яркости (-1..1),
// lut/lutAmount — цветовая таблица (см. LUTS) и её сила, sharp — резкость (0..1), tint/tintAmount — подкраска,
// opacity — прозрачность вебки, flip — отражение по горизонтали.
// Движения — как в motion() офлайн-рендера; RGB-сдвиг и блюр без плагинов OBS недоступны.
const ex = Math.exp;
const TINTS = [[1, 0.25, 0.3], [0.3, 0.5, 1], [0.4, 1, 0.5], [1, 0.3, 1], [1, 0.8, 0.3]];
const EFFECTS = {
  // ---- движение
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
  zoomspin: (u, d) => ({ zoom: 1.1 + 0.4 * Math.abs(Math.sin(u * Math.PI)), tilt: d * 14 * Math.sin(u * Math.PI * 2) }),
  spin: (u, d) => ({ zoom: 1.2, spin: d * 360 * (1 - Math.pow(1 - u, 3)) }), // полный оборот за бит
  flip: (u) => ({ zoom: 1.12 + 0.3 * ex(-u * 7), flip: u < 0.5 }),
  glitch: (u, d, rnd) => {
    const slot = Math.floor(u * 14);
    const on = rnd(slot) > 0.45;
    return {
      zoom: 1.12 + (on ? rnd(slot + 50) * 0.15 : 0),
      ox: on ? (rnd(slot + 100) - 0.5) * 0.09 : 0, oy: on ? (rnd(slot + 200) - 0.5) * 0.05 : 0,
      hue: on && rnd(slot + 300) > 0.6 ? (rnd(slot + 400) - 0.5) * 180 : 0, contrast: 1.3,
      sharp: on ? 0.8 : 0, lut: "invert", lutAmount: on && rnd(slot + 500) > 0.85 ? 1 : 0,
    };
  },
  // ---- цвет и фильтры
  flash: (u) => ({ zoom: 1.1 + 0.35 * ex(-u * 8), ox: Math.sin(u * 36) * 0.01 * (1 - u), bright: u < 0.06 ? 0.85 : u < 0.14 ? 0.3 : 0 }),
  strobe: (u) => ({ zoom: 1.12, bright: Math.floor(u * 8) % 2 ? 0.55 : 0 }),
  flicker: (u) => ({ zoom: 1.12, opacity: Math.floor(u * 10) % 2 ? 0.25 : 1 }),
  hue: (u, d) => ({ zoom: 1.08 + 0.25 * ex(-u * 6), hue: d * (80 + 200 * u), sat: 1.55 }),
  tint: (u, d, rnd) => ({ zoom: 1.1 + 0.28 * ex(-u * 7), tint: TINTS[Math.floor(rnd(0) * TINTS.length)], tintAmount: 0.85 * ex(-u * 3) }),
  mono: (u) => ({ zoom: 1.15 + 0.25 * ex(-u * 7), sat: 0, contrast: 1.6 }),
  crunch: (u) => ({ zoom: 1.18 + 0.2 * ex(-u * 7), sharp: ex(-u * 3), contrast: 1.45, sat: 1.3 }),
  invert: (u) => ({ zoom: 1 + 0.3 * ex(-u * 7), lut: "invert", lutAmount: u < 0.45 ? 1 : 0 }),
  xerox: (u) => ({ zoom: 1.12 + 0.25 * ex(-u * 8), lut: "xerox", lutAmount: u < 0.6 ? 1 : 0 }),
  poster: (u) => ({ zoom: 1.14 + 0.15 * ex(-u * 6), lut: "poster", lutAmount: 1, contrast: 1.15 }),
  sepia: (u) => ({ zoom: 1.1 + 0.2 * ex(-u * 6), lut: "sepia", lutAmount: 1, bright: u < 0.05 ? 0.4 : 0 }),
  duotone: (u, d) => ({ zoom: 1.12 + 0.22 * ex(-u * 6), lut: d > 0 ? "duotonePink" : "duotoneCyan", lutAmount: 1 }),
  thermal: (u) => ({ zoom: 1.15 + 0.2 * ex(-u * 6), lut: "thermal", lutAmount: 1 }),
  nightvision: (u) => ({ zoom: 1.18, ox: Math.sin(u * 40) * 0.006, lut: "nightvision", lutAmount: 1, bright: u < 0.08 ? 0.3 : 0 }),
};
const EFFECT_KEYS = Object.keys(EFFECTS);
const LUT_EFFECTS = new Set(["glitch", "invert", "xerox", "poster", "sepia", "duotone", "thermal", "nightvision"]);
const SHARP_EFFECTS = new Set(["glitch", "crunch"]);

// Случайные числа на бит: одинаковые для одного i, пока идёт этот бит (иначе глитч дрожал бы каждый кадр)
function beatRandom(seed) {
  return (i) => {
    const x = Math.sin(seed * 9973.13 + i * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
}

// Сила эффектов (100% = как в пресете): масштабируем отклонение от «как есть»
function scaleLook(look, k) {
  return {
    zoom: 1 + ((look.zoom || 1) - 1) * k,
    ox: (look.ox || 0) * k,
    oy: (look.oy || 0) * k,
    tilt: (look.tilt || 0) * k + (look.spin || 0), // полный оборот не масштабируем — иначе в конце бита рывок
    hue: (look.hue || 0) * k,
    sat: 1 + ((look.sat ?? 1) - 1) * k,
    contrast: 1 + ((look.contrast ?? 1) - 1) * k,
    bright: (look.bright || 0) * k,
    box: 1 + ((look.box ?? 1) - 1) * k,
    lut: look.lut || null,
    lutAmount: clamp((look.lutAmount || 0) * k, 0, 1),
    sharp: clamp((look.sharp || 0) * k, 0, 1),
    tint: look.tint || null,
    tintAmount: clamp((look.tintAmount || 0) * k, 0, 1),
    opacity: clamp(1 - (1 - (look.opacity ?? 1)) * k, 0.05, 1),
    flip: Boolean(look.flip),
  };
}

// Эффект → настройки элемента сцены. Зум и тряска — через обрезку (кадр «наезжает» внутри той же рамки:
// масштаб растёт ровно настолько, насколько уменьшилась видимая часть), наклон — поворот вокруг центра рамки,
// пульс рамки — сама рамка больше/меньше вокруг центра, отражение — отрицательный масштаб, центр тот же.
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
  const box = Math.max(0.5, look.box || 1);
  const flip = look.flip ? -1 : 1;
  let Dw, Dh;
  if (bounded) {
    Dw = T.boundsWidth;
    Dh = T.boundsHeight; // в рамке OBS сам растягивает обрезанное до прежнего размера
    if (box !== 1) {
      out.boundsWidth = T.boundsWidth * box;
      out.boundsHeight = T.boundsHeight * box;
    }
    if (flip < 0) out.scaleX = -T.scaleX;
  } else {
    out.scaleX = T.scaleX * (w0 / (W - out.cropLeft - out.cropRight)) * box * flip;
    out.scaleY = T.scaleY * (h0 / (H - out.cropTop - out.cropBottom)) * box;
    Dw = w0 * T.scaleX;
    Dh = h0 * T.scaleY;
  }
  const geo = centerOf(T, Dw, Dh);                  // центр исходной рамки — он остаётся на месте
  const grown = centerOf(T, Dw * box * flip, Dh * box); // вектор от точки привязки до центра для новой рамки
  const rotation = T.rotation + (look.tilt || 0);
  const r = (rotation * Math.PI) / 180;
  out.rotation = rotation;
  out.positionX = geo.cx - (grown.vx * Math.cos(r) - grown.vy * Math.sin(r));
  out.positionY = geo.cy - (grown.vx * Math.sin(r) + grown.vy * Math.cos(r));
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

// Цвет OBS хранит как ABGR в одном числе
const abgr = ([r, g, b], a = 1) =>
  ((Math.round(a * 255) << 24) | (Math.round(b * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(r * 255)) >>> 0;

function colorSettings(look) {
  const hue = ((look.hue % 360) + 540) % 360 - 180;
  const mul = look.tint && look.tintAmount > 0.01
    ? abgr(look.tint.map(c => 1 + (c - 1) * look.tintAmount))
    : 0xffffffff;
  return {
    hue_shift: Math.round(hue * 10) / 10,
    saturation: Math.round(clamp(look.sat - 1, -1, 5) * 1000) / 1000,
    contrast: Math.round(clamp((look.contrast - 1) * 1.5, -4, 4) * 1000) / 1000,
    brightness: Math.round(clamp(look.bright, -1, 1) * 1000) / 1000,
    opacity: Math.round(look.opacity * 100) / 100,
    color_multiply: mul,
  };
}

// ---------------------------------------------------------------- цветовые таблицы (LUT) для «Применить LUT»

// Встроенный фильтр OBS «Применить LUT» понимает текстовые .cube — генерируем свои при запуске бота
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (c0, c1, t) => c0.map((v, i) => v + (c1[i] - v) * t);
function gradient(stops, x) {
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return stops[stops.length - 1][1];
}
const LUTS = {
  invert: (r, g, b) => [1 - r, 1 - g, 1 - b],
  xerox: (r, g, b) => { const v = smooth(0.42, 0.58, luma(r, g, b)); return [v, v, v]; },
  poster: (r, g, b) => {
    const L = luma(r, g, b);
    return [r, g, b].map(c => Math.round(clamp(L + (c - L) * 1.4, 0, 1) * 3) / 3);
  },
  sepia: (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b],
  duotonePink: (r, g, b) => mix([0.08, 0.02, 0.25], [1, 0.45, 0.75], smooth(0, 1, luma(r, g, b))),
  duotoneCyan: (r, g, b) => mix([0.02, 0.05, 0.2], [0.3, 1, 0.95], smooth(0, 1, luma(r, g, b))),
  thermal: (r, g, b) => gradient([
    [0, [0, 0, 0.1]], [0.25, [0.25, 0, 0.6]], [0.5, [0.9, 0, 0.3]], [0.7, [1, 0.5, 0]], [0.85, [1, 0.9, 0.1]], [1, [1, 1, 1]],
  ], luma(r, g, b)),
  nightvision: (r, g, b) => { const L = Math.min(1, luma(r, g, b) * 1.4 + 0.05); return [0.08 * L, 0.95 * Math.pow(L, 0.9), 0.12 * L]; },
};

function writeLuts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const N = 17;
  const files = {};
  for (const [name, fn] of Object.entries(LUTS)) {
    const lines = [`TITLE "TwEmotesBot ${name}"`, `LUT_3D_SIZE ${N}`];
    for (let bi = 0; bi < N; bi++) {
      for (let gi = 0; gi < N; gi++) {
        for (let ri = 0; ri < N; ri++) { // в .cube быстрее всего меняется красный
          const out = fn(ri / (N - 1), gi / (N - 1), bi / (N - 1)).map(v => clamp(v, 0, 1).toFixed(5));
          lines.push(out.join(" "));
        }
      }
    }
    const file = path.join(dir, `${name}.cube`);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    files[name] = file;
  }
  return files;
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
    try {
      this.luts = writeLuts(path.join(dataDir, "luts"));
    } catch (err) {
      this.luts = {};
      log(`[EDIT] Could not write LUT files: ${err.message}`);
    }
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
      showBeat: cfg.editShowBeat === true,
      alwaysPunch: cfg.editAlwaysPunch !== false,
      boxPulse: cfg.editBoxPulse !== false ? clamp(Number(cfg.editBoxPulseAmount ?? 12), 0, 60) / 100 : 0,
    };
    if (!this.cfg.effects.length) this.cfg.effects = ["punch"];
    if (this.cfg.enabled) this.obs.configure({ host: cfg.obsHost, port: cfg.obsPort, password: cfg.obsPassword });
    else this.obs.disconnect();
    this.updateBeatIndicator();
  }

  // ---- индикатор бита в оверлее (для проверки, как бот слышит музыку): «beat-tick» на каждый бит,
  // который использует эдит, и «beat-status» дважды в секунду (есть ли звук, темп, найдена ли сетка)
  beatStatus() {
    const show = Boolean(this.cfg && this.cfg.enabled && this.cfg.showBeat);
    if (!show) return { type: "beat-status", show: false };
    const pos = this.tracker.position(Date.now() + this.cfg.latency);
    return { type: "beat-status", show: true, active: Boolean(pos), bpm: pos ? Math.round(pos.bpm) : null, locked: pos ? pos.locked : false };
  }

  updateBeatIndicator() {
    clearInterval(this.beatTimer);
    this.overlay(this.beatStatus());
    if (!this.beatStatus().show) return;
    let lastStatusAt = 0;
    this.beatTimer = setInterval(() => {
      const now = Date.now();
      const pos = this.tracker.position(now + this.cfg.latency);
      if (pos && pos.index !== this.tickBeat) {
        this.tickBeat = pos.index;
        this.overlay({ type: "beat-tick", locked: pos.locked, bpm: Math.round(pos.bpm), period: pos.period });
      }
      if (now - lastStatusAt > 500) {
        lastStatusAt = now;
        this.overlay(this.beatStatus());
      }
    }, 15);
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

  // Какие фильтры нужны выбранным эффектам: цвет — всегда, LUT и резкость — только если есть такие эффекты
  neededFilters() {
    const keys = ["color"];
    if (this.cfg.effects.some(e => LUT_EFFECTS.has(e))) keys.push("lut");
    if (this.cfg.effects.some(e => SHARP_EFFECTS.has(e))) keys.push("sharp");
    return keys;
  }

  async ensureFilters(keys) {
    for (const key of keys) {
      const f = FILTERS[key];
      try {
        await this.obs.request("GetSourceFilter", { sourceName: this.cfg.camera, filterName: f.name });
      } catch (err) {
        if (err.code !== 600) throw err; // 600 — ResourceNotFound: фильтра ещё нет
        await this.obs.request("CreateSourceFilter", {
          sourceName: this.cfg.camera, filterName: f.name, filterKind: f.kind, filterSettings: f.neutral,
        });
        this.log(`[EDIT] Added filter "${f.name}" (${f.kind}) to "${this.cfg.camera}"`);
      }
    }
  }

  filterRequests(keys, enabled) {
    const cam = this.cfg.camera;
    return keys.flatMap(key => [
      { requestType: "SetSourceFilterSettings", requestData: { sourceName: cam, filterName: FILTERS[key].name, filterSettings: FILTERS[key].neutral, overlay: true } },
      { requestType: "SetSourceFilterEnabled", requestData: { sourceName: cam, filterName: FILTERS[key].name, filterEnabled: enabled } },
    ]);
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
      ...(T.boundsType && T.boundsType !== "OBS_BOUNDS_NONE" ? { boundsWidth: T.boundsWidth, boundsHeight: T.boundsHeight } : {}),
    };
    // если бот упадёт посреди эдита — при следующем подключении вернём как было
    fs.writeFileSync(this.restoreFile, JSON.stringify({ ...item, original }), "utf8");
    const filters = this.neededFilters();
    await this.ensureFilters(filters);
    await this.obs.batch(this.filterRequests(filters, true));

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
      beat: null, effect: "punch", dir: 1, seed: Math.random(), lastColor: null, chatTriggered: !force,
      filters, lastLutKey: null, lastSharp: null,
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
          ...this.filterRequests(s.filters, false),
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
      // каких-то фильтров может и не быть — ошибки отдельных запросов пакет не прерывают
      await this.obs.batch(this.filterRequests(Object.keys(FILTERS), false)).catch(() => {});
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
      s.seed = Math.random();
      if (this.cfg.emotes) {
        const emotes = this.emotePool();
        if (emotes.length) this.overlay({ type: "edit-beat", period: pos.period, emotes: emotes.slice(0, 3), effect: s.effect });
      }
    }

    // между битами (и в тишине) эффект затухает; поверх — лёгкий «дрейф», как в рендере
    const u = pos ? pos.u : 2;
    const base = u <= 1.15 ? EFFECTS[s.effect](Math.min(u, 1), s.dir, beatRandom(s.seed)) : { zoom: 1.04 };
    const t = (now - s.startedAt) / 1000;
    base.zoom = Math.max(base.zoom || 1, 1.04);
    // зум-удар на каждый бит под любым эффектом; если эффект сам зумит сильнее — остаётся его зум
    if (this.cfg.alwaysPunch && pos && u <= 1.15) base.zoom = Math.max(base.zoom, 1 + 0.32 * Math.exp(-Math.min(u, 1) * 7));
    // пульс рамки: на бит источник подрастает и отпружинивает обратно (с лёгким недолётом перед следующим битом)
    if (this.cfg.boxPulse && pos && u <= 1.15) {
      const uu = Math.min(u, 1);
      base.box = 1 + this.cfg.boxPulse * Math.exp(-uu * 5) * Math.cos(uu * Math.PI * 1.6);
    }
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
    // LUT: файл таблицы меняем только вместе с эффектом (OBS перечитывает его), силу — ступенями по 0.1
    if (s.filters.includes("lut")) {
      const file = look.lut && this.luts[look.lut];
      const amount = file ? Math.round(look.lutAmount * 10) / 10 : 0;
      const key = amount ? `${file}|${amount}` : "off";
      if (key !== s.lastLutKey) {
        s.lastLutKey = key;
        const settings = amount ? { image_path: file, clut_amount: amount } : { clut_amount: 0 };
        requests.push({ requestType: "SetSourceFilterSettings", requestData: { sourceName: this.cfg.camera, filterName: FILTERS.lut.name, filterSettings: settings, overlay: true } });
      }
    }
    if (s.filters.includes("sharp")) {
      const sharp = Math.round(look.sharp * 20) / 20;
      if (sharp !== s.lastSharp) {
        s.lastSharp = sharp;
        requests.push({ requestType: "SetSourceFilterSettings", requestData: { sourceName: this.cfg.camera, filterName: FILTERS.sharp.name, filterSettings: { sharpness: sharp }, overlay: true } });
      }
    }
    if (!requests.length) return;
    this.busy = true;
    this.obs.batch(requests).catch(() => {}).finally(() => { this.busy = false; });
  }

  // При выключении бота: вернуть камеру и дождаться ответа OBS (не дольше timeoutMs)
  async shutdown(timeoutMs = 1500) {
    clearInterval(this.beatTimer);
    if (this.session) {
      await Promise.race([this.endSession("бот выключается", { restore: true }), new Promise(r => setTimeout(r, timeoutMs))]);
    }
    this.obs.disconnect();
  }
}

module.exports = { EditController, BeatTracker, EFFECT_KEYS, buildTransform, centerOf, colorSettings, scaleLook, EFFECTS, LUTS, writeLuts, beatRandom };
