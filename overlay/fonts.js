// Шрифты для текста приветствия. Общий файл для оверлея и панели (панель берёт его как /overlay/fonts.js).
// GOOGLE_FONTS подгружаются с fonts.googleapis.com (все с кириллицей); остальное — системные шрифты Windows.
window.GREETING_FONTS = {
  system: ["Arial", "Segoe UI", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Impact", "Comic Sans MS", "Consolas"],
  google: [
    "Montserrat", "Roboto", "Rubik", "Oswald", "Ubuntu", "PT Sans", "Russo One", "Comfortaa",
    "Press Start 2P", "Lobster", "Pacifico", "Caveat", "Marck Script", "Neucha", "Pangolin", "Rubik Mono One",
  ],
};

const greetingFontCss = new Map(); // family -> Promise, CSS с @font-face подключён

function addStylesheet(href) {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

// Подключает Google-шрифт (если это он) и ждёт, пока он загрузится. Для остальных — сразу.
window.ensureGreetingFont = function ensureGreetingFont(family, weight) {
  if (!family || !window.GREETING_FONTS.google.includes(family)) return Promise.resolve();

  if (!greetingFontCss.has(family)) {
    // Google отвечает ошибкой на весь запрос, если у шрифта нет одного из весов (у Lobster нет 700),
    // поэтому обычный и жирный подключаем отдельно: жирного может не быть — тогда браузер утолщит сам.
    const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`;
    greetingFontCss.set(family, Promise.all([
      addStylesheet(`${base}&display=swap`),
      addStylesheet(`${base}:wght@700&display=swap`),
    ]));
  }

  const ready = greetingFontCss.get(family).then(() =>
    document.fonts && document.fonts.load
      ? document.fonts.load(`${weight || 400} 32px "${family}"`, "AaЯя").catch(() => {})
      : undefined
  );
  // не ждём шрифт дольше 2 с — лучше показать приветствие запасным шрифтом, чем опоздать
  return Promise.race([ready, new Promise((r) => setTimeout(r, 2000))]);
};
