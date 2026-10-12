// Анимации появления приветствия — один список для оверлея, панели (плитки с демо) и сервера (проверка конфига).
// keyframes/options — в формате Web Animations API (element.animate), origin — transform-origin на время анимации.
(function (root) {
  const EASE_OUT = "cubic-bezier(.2, .8, .2, 1)";

  // ---- переходы в духе Windows Movie Maker: картинка проявляется через растущую фигуру (clip-path).
  // Анимировать можно только фигуры с одинаковым числом точек, поэтому все polygon() строятся генераторами.
  const P = (x, y) => `${x.toFixed(2)}% ${y.toFixed(2)}%`;
  const polygon = (pts) => `polygon(${pts.join(", ")})`;

  // фигура в единичных координатах (-1..1), растёт из центра от точки до масштаба maxScale
  function growShape(unitPts, maxScale) {
    const at = (k) => polygon(unitPts.map(([x, y]) => P(50 + x * k * 50, 50 + y * k * 50)));
    return [{ clipPath: at(0) }, { clipPath: at(maxScale) }];
  }

  // нелинейные переходы — набор кадров fn(t), t = 0..1
  function frames(fn, steps) {
    return Array.from({ length: steps + 1 }, (_, i) => ({ clipPath: fn(i / steps), offset: i / steps }));
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const STAR = Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.45 : 1;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const HEART = Array.from({ length: 48 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [x / 17, -(y + 2.5) / 17];
  });
  const KEYHOLE = [
    ...Array.from({ length: 28 }, (_, i) => {
      const a = ((110 + (i * 320) / 27) * Math.PI) / 180; // дуга через верх, от нижне-левой к нижне-правой
      return [0.42 * Math.cos(a), -0.3 + 0.42 * Math.sin(a)];
    }),
    [0.34, 0.8], [-0.34, 0.8],
  ];
  const CROSS = [[-0.3, -1], [0.3, -1], [0.3, -0.3], [1, -0.3], [1, 0.3], [0.3, 0.3],
    [0.3, 1], [-0.3, 1], [-0.3, 0.3], [-1, 0.3], [-1, -0.3], [-0.3, -0.3]];
  const DIAMOND = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // полосы: каждая проявляется от своего края; все соединительные отрезки лежат на одной линии — площади не дают
  const EDGE = -12, FAR = 112;
  function stripes(count, t, vertical) {
    const pts = [];
    const step = (FAR - EDGE) / count;
    for (let i = 0; i < count; i++) {
      const a = EDGE + i * step;
      const b = a + step * t;
      const quad = [[EDGE, a], [FAR, a], [FAR, b], [EDGE, b]];
      for (const [u, v] of quad) pts.push(vertical ? P(v, u) : P(u, v));
    }
    return polygon(pts);
  }

  // шахматы: клетки одного цвета проявляются в первой половине, другого — во второй
  function checker(t, cols = 6, rows = 6) {
    const pts = [];
    const cw = (FAR - EDGE) / cols;
    const rh = (FAR - EDGE) / rows;
    for (let r = 0; r < rows; r++) {
      const y0 = EDGE + r * rh;
      const y1 = y0 + rh;
      pts.push(P(EDGE, y0));
      for (let c = 0; c < cols; c++) {
        const x0 = EDGE + c * cw;
        const p = (r + c) % 2 === 0 ? clamp01(t * 2) : clamp01(t * 2 - 1);
        const x1 = x0 + cw * p;
        pts.push(P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0));
      }
      pts.push(P(EDGE, y0)); // назад по верхней линии ряда
    }
    return polygon(pts);
  }

  // часы: сектор, который заметает круг по часовой стрелке от 12 часов
  function clock(t, points = 36) {
    const sweep = Math.PI * 2 * t;
    const pts = [P(50, 50)];
    for (let i = 0; i <= points; i++) {
      const a = -Math.PI / 2 + (sweep * i) / points;
      pts.push(P(50 + Math.cos(a) * 150, 50 + Math.sin(a) * 150));
    }
    return polygon(pts);
  }

  const WIPE_IN = "inset(-15% -15% -15% -15%)"; // конец шторок: чуть шире блока, чтобы не резать обводку текста

  const GREETING_ANIMATIONS = [
    { key: "none", label: "Сразу", keyframes: null },
    {
      key: "fade", label: "Плавно",
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      options: { duration: 450, easing: "ease-out" },
    },
    {
      key: "pop", label: "Выпрыгивает",
      keyframes: [
        { opacity: 0, transform: "scale(.3)" },
        { opacity: 1, transform: "scale(1.08)", offset: 0.7 },
        { opacity: 1, transform: "scale(1)" },
      ],
      options: { duration: 450, easing: "ease-out" },
    },
    {
      key: "zoom", label: "Налетает",
      keyframes: [{ opacity: 0, transform: "scale(2.6)" }, { opacity: 1, transform: "scale(1)" }],
      options: { duration: 500, easing: EASE_OUT },
    },
    {
      key: "slideUp", label: "Снизу",
      keyframes: [{ opacity: 0, transform: "translateY(140px)" }, { opacity: 1, transform: "translateY(0)" }],
      options: { duration: 550, easing: EASE_OUT },
    },
    {
      key: "slideDown", label: "Сверху",
      keyframes: [{ opacity: 0, transform: "translateY(-140px)" }, { opacity: 1, transform: "translateY(0)" }],
      options: { duration: 550, easing: EASE_OUT },
    },
    {
      key: "fromLeft", label: "Слева",
      keyframes: [{ opacity: 0, transform: "translateX(-200px)" }, { opacity: 1, transform: "translateX(0)" }],
      options: { duration: 550, easing: EASE_OUT },
    },
    {
      key: "fromRight", label: "Справа",
      keyframes: [{ opacity: 0, transform: "translateX(200px)" }, { opacity: 1, transform: "translateX(0)" }],
      options: { duration: 550, easing: EASE_OUT },
    },
    {
      key: "drop", label: "Падает с отскоком",
      keyframes: [
        { opacity: 0, transform: "translateY(-420px)" },
        { opacity: 1, transform: "translateY(0)", offset: 0.5 },
        { transform: "translateY(-45px)", offset: 0.68 },
        { transform: "translateY(0)", offset: 0.82 },
        { transform: "translateY(-12px)", offset: 0.91 },
        { opacity: 1, transform: "translateY(0)" },
      ],
      options: { duration: 1000, easing: "ease-out" },
    },
    {
      key: "bounce", label: "Подпрыгивает",
      keyframes: [
        { opacity: 0, transform: "scale(0)" },
        { opacity: 1, transform: "scale(1.25)", offset: 0.5 },
        { transform: "scale(.9)", offset: 0.7 },
        { transform: "scale(1.05)", offset: 0.85 },
        { opacity: 1, transform: "scale(1)" },
      ],
      options: { duration: 750, easing: "ease-out" },
    },
    {
      key: "spin", label: "С вращением",
      keyframes: [{ opacity: 0, transform: "rotate(-540deg) scale(.2)" }, { opacity: 1, transform: "rotate(0deg) scale(1)" }],
      options: { duration: 800, easing: EASE_OUT },
    },
    {
      key: "flip", label: "Переворот",
      keyframes: [
        { opacity: 0, transform: "perspective(700px) rotateY(90deg)" },
        { opacity: 1, transform: "perspective(700px) rotateY(-12deg)", offset: 0.7 },
        { opacity: 1, transform: "perspective(700px) rotateY(0deg)" },
      ],
      options: { duration: 650, easing: "ease-out" },
    },
    {
      key: "blur", label: "Из размытия",
      keyframes: [
        { opacity: 0, filter: "blur(22px)", transform: "scale(1.15)" },
        { opacity: 1, filter: "blur(0px)", transform: "scale(1)" },
      ],
      options: { duration: 650, easing: "ease-out" },
    },
    {
      key: "swing", label: "Качается",
      origin: "50% 0%",
      keyframes: [
        { opacity: 0, transform: "rotate(-40deg)" },
        { opacity: 1, transform: "rotate(20deg)", offset: 0.35 },
        { transform: "rotate(-11deg)", offset: 0.6 },
        { transform: "rotate(5deg)", offset: 0.8 },
        { opacity: 1, transform: "rotate(0deg)" },
      ],
      options: { duration: 1100, easing: "ease-out" },
    },
    {
      key: "jelly", label: "Желе",
      keyframes: [
        { opacity: 0, transform: "scale(0, 0)" },
        { opacity: 1, transform: "scale(1.25, .75)", offset: 0.3 },
        { transform: "scale(.75, 1.25)", offset: 0.45 },
        { transform: "scale(1.15, .85)", offset: 0.6 },
        { transform: "scale(.95, 1.05)", offset: 0.75 },
        { transform: "scale(1.05, .95)", offset: 0.9 },
        { opacity: 1, transform: "scale(1, 1)" },
      ],
      options: { duration: 950, easing: "ease-out" },
    },
    {
      key: "rise", label: "Вырастает",
      origin: "50% 100%",
      keyframes: [
        { opacity: 0, transform: "scaleY(0)" },
        { opacity: 1, transform: "scaleY(1.12)", offset: 0.7 },
        { opacity: 1, transform: "scaleY(1)" },
      ],
      options: { duration: 550, easing: "ease-out" },
    },
    {
      key: "shake", label: "Трясётся",
      keyframes: [
        { opacity: 0, transform: "translateX(0)" },
        { opacity: 1, transform: "translateX(-22px) rotate(-5deg)", offset: 0.15 },
        { transform: "translateX(18px) rotate(4deg)", offset: 0.3 },
        { transform: "translateX(-14px) rotate(-3deg)", offset: 0.45 },
        { transform: "translateX(10px) rotate(2deg)", offset: 0.6 },
        { transform: "translateX(-5px) rotate(-1deg)", offset: 0.8 },
        { opacity: 1, transform: "translateX(0) rotate(0deg)" },
      ],
      options: { duration: 800, easing: "ease-out" },
    },
    // ---------- переходы (как в Windows Movie Maker) ----------
    {
      key: "wipe", label: "Шторка", group: "wmm",
      keyframes: [{ clipPath: "inset(-15% 115% -15% -15%)" }, { clipPath: WIPE_IN }],
      options: { duration: 700, easing: "ease-in-out" },
    },
    {
      key: "wipeDown", label: "Шторка вниз", group: "wmm",
      keyframes: [{ clipPath: "inset(-15% -15% 115% -15%)" }, { clipPath: WIPE_IN }],
      options: { duration: 700, easing: "ease-in-out" },
    },
    {
      key: "split", label: "Раздвижка", group: "wmm",
      keyframes: [{ clipPath: "inset(-15% 50% -15% 50%)" }, { clipPath: WIPE_IN }],
      options: { duration: 700, easing: "ease-in-out" },
    },
    {
      key: "box", label: "Прямоугольник", group: "wmm",
      keyframes: [{ clipPath: "inset(50% 50% 50% 50%)" }, { clipPath: WIPE_IN }],
      options: { duration: 700, easing: "ease-in-out" },
    },
    {
      key: "circle", label: "Круг", group: "wmm",
      keyframes: [{ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(85% at 50% 50%)" }],
      options: { duration: 750, easing: "ease-in" },
    },
    {
      key: "eye", label: "Глаз", group: "wmm",
      keyframes: [{ clipPath: "ellipse(90% 0% at 50% 50%)" }, { clipPath: "ellipse(95% 95% at 50% 50%)" }],
      options: { duration: 750, easing: "ease-in-out" },
    },
    {
      key: "diamond", label: "Ромб", group: "wmm",
      keyframes: growShape(DIAMOND, 2.4),
      options: { duration: 750, easing: "ease-in" },
    },
    {
      key: "star", label: "Звезда", group: "wmm",
      keyframes: growShape(STAR, 3.6),
      options: { duration: 900, easing: "ease-in" },
    },
    {
      key: "heart", label: "Сердце", group: "wmm",
      keyframes: growShape(HEART, 3.4),
      options: { duration: 900, easing: "ease-in" },
    },
    {
      key: "keyhole", label: "Замочная скважина", group: "wmm",
      keyframes: growShape(KEYHOLE, 4),
      options: { duration: 900, easing: "ease-in" },
    },
    {
      key: "cross", label: "Крест", group: "wmm",
      keyframes: growShape(CROSS, 4),
      options: { duration: 800, easing: "ease-in" },
    },
    {
      key: "blinds", label: "Жалюзи", group: "wmm",
      keyframes: [{ clipPath: stripes(8, 0, false) }, { clipPath: stripes(8, 1, false) }],
      options: { duration: 750, easing: "ease-in-out" },
    },
    {
      key: "bars", label: "Полосы", group: "wmm",
      keyframes: [{ clipPath: stripes(8, 0, true) }, { clipPath: stripes(8, 1, true) }],
      options: { duration: 750, easing: "ease-in-out" },
    },
    {
      key: "checker", label: "Шахматы", group: "wmm",
      keyframes: frames((t) => checker(t), 8),
      options: { duration: 900, easing: "linear" },
    },
    {
      key: "clock", label: "Часы", group: "wmm",
      keyframes: frames((t) => clock(t), 24),
      options: { duration: 900, easing: "linear" },
    },
    {
      key: "diagonal", label: "Диагональ", group: "wmm",
      keyframes: [
        { clipPath: polygon([P(-20, -20), P(-20, -20), P(-20, -20)]) },
        { clipPath: polygon([P(-20, -20), P(260, -20), P(-20, 260)]) },
      ],
      options: { duration: 750, easing: "ease-in-out" },
    },
  ];

  // у «движений» группа не указана
  for (const anim of GREETING_ANIMATIONS) anim.group = anim.group || "motion";
  const GREETING_ANIMATION_GROUPS = [
    { key: "motion", label: "Движение" },
    { key: "wmm", label: "Переходы (как в Windows Movie Maker)" },
  ];

  const byKey = Object.fromEntries(GREETING_ANIMATIONS.map(a => [a.key, a]));

  // Запускает анимацию появления на элементе; возвращает Animation или null
  function playGreetingAnimation(el, key) {
    const anim = byKey[key];
    if (!anim || !anim.keyframes || !el.animate) return null;
    el.style.transformOrigin = anim.origin || "50% 50%";
    return el.animate(anim.keyframes, { fill: "backwards", ...anim.options });
  }

  // Случайная анимация из выбранных, по возможности не та же, что в прошлый раз
  function pickGreetingAnimation(keys, previous) {
    const valid = (Array.isArray(keys) ? keys : [keys]).filter(k => byKey[k]);
    if (!valid.length) return "none";
    const pool = valid.length > 1 ? valid.filter(k => k !== previous) : valid;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const api = { GREETING_ANIMATIONS, GREETING_ANIMATION_GROUPS, playGreetingAnimation, pickGreetingAnimation };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== "undefined" ? window : this);
