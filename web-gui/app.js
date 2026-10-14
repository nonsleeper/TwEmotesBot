// Панель управления Emotes Bot.
// Состояние: saved — конфиг с сервера, форма — черновик; разница между ними = несохранённые изменения.

const $ = (id) => document.getElementById(id);

const PAGE_SIZE = 150; // эмоутов в выдаче за раз; следующая порция — при прокрутке до конца
const PROVIDERS = [
  { key: 'all', label: 'Все' },
  { key: 'twitch', label: 'Twitch' },
  { key: '7tv', label: '7TV' },
  { key: 'bttv', label: 'BTTV' },
  { key: 'ffz', label: 'FFZ' },
];
const PROVIDER_LABEL = Object.fromEntries(PROVIDERS.map(p => [p.key, p.label]));

// source из кэша бота ("7TV channel", "Twitch global"...). Для старого кэша без source — угадываем по id.
function detectProvider(source, id) {
  const head = String(source || '').split(' ')[0].toLowerCase();
  if (['twitch', '7tv', 'bttv', 'ffz'].includes(head)) return head;
  if (/^01[0-9A-HJKMNP-TV-Z]{24}$/i.test(id)) return '7tv';
  if (/^[0-9a-f]{24}$/i.test(id)) return 'bttv';
  return 'twitch';
}

const MAX_LOG_LINES = 2000;

// Какие ключи конфига на какой вкладке (для бейджей несохранённых изменений)
const KEY_TAB = {
  channel: 'connection', twitchClientId: 'connection', twitchClientSecret: 'connection', port: 'connection',
  greetingKeywords: 'greetings', greetingEmotes: 'greetings', greetingExpireDays: 'greetings', oldFilesExpireDays: 'greetings',
  emoteSpamLimit: 'emotes', emoteSpamWindow: 'emotes', emoteBoostOnSameFromDifferentUser: 'emotes',
  emoteBoostScalePercent: 'emotes', emoteBlacklist: 'emotes', emoteDisplaySeconds: 'emotes', emoteSize: 'emotes',
  greetingDisplaySeconds: 'greetings', greetingVolume: 'greetings', greetingFontFamily: 'greetings',
  greetingFontSize: 'greetings', greetingBold: 'greetings', greetingTextColor: 'greetings',
  greetingOutlineColor: 'greetings', greetingOutlineWidth: 'greetings', greetingShadow: 'greetings',
  greetingEmoteSize: 'greetings', greetingTemplate: 'greetings', greetingAnimations: 'greetings',
  gameElementX: 'game', gameElementY: 'game', gameElementScale: 'game', gameElementTemplate: 'game',
  gameShowBoxArt: 'game', gameShowPaused: 'game', gameHideWhenNoGame: 'game', gameIdleMinutes: 'game',
  gameFontFamily: 'game', gameFontSize: 'game', gameBold: 'game', gameTextColor: 'game',
  gameOutlineColor: 'game', gameOutlineWidth: 'game', gameShadow: 'game',
  editEnabled: 'edit', obsHost: 'edit', obsPort: 'edit', obsPassword: 'edit', editCameraSource: 'edit',
  editAudioSource: 'edit', editCommand: 'edit', editDuration: 'edit', editCooldown: 'edit', editWho: 'edit',
  editIntensity: 'edit', editEffects: 'edit', editLatencyMs: 'edit', editAlwaysPunch: 'edit', editBoxPulse: 'edit', editBoxPulseAmount: 'edit',
  editRewardEnabled: 'edit', editRewardTitle: 'edit', editRewardCost: 'edit', editRewardDuration: 'edit', editRewardBoost: 'edit',
};

const state = {
  saved: null,          // последний конфиг с сервера
  emotes: [],           // [{ code, id, format, lower }]
  emoteByCode: new Map(),
  bot: 'stopped',       // stopped | starting | running
  busy: false,
};

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

function toast(text, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text });
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Регистр важен: на 7TV/BTTV "LUL" и "lul" — разные эмоуты
function hasCode(list, code) {
  return list.includes(String(code));
}

function emoteImg(emote, alt) {
  const formats = [emote.format, 'webp', 'gif', 'png'].filter((f, i, a) => f && a.indexOf(f) === i);
  let i = 0;
  const img = el('img', { alt: alt || emote.code, loading: 'lazy', src: `/cache/emotes/${emote.id}.${formats[0]}` });
  img.onerror = () => {
    i++;
    if (i < formats.length) img.src = `/cache/emotes/${emote.id}.${formats[i]}`;
    else img.onerror = null;
  };
  return img;
}

// ---------------------------------------------------------------- tag input (слова-приветствия)

function createTagInput(root, { placeholder, onChange }) {
  let values = [];
  const input = el('input', { placeholder, spellcheck: 'false' });

  function add(raw) {
    const parts = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let changed = false;
    for (const p of parts) {
      if (!values.includes(p)) { values.push(p); changed = true; }
    }
    if (changed) { render(); onChange(); }
  }

  function remove(value) {
    values = values.filter(v => v !== value);
    render();
    onChange();
  }

  function render() {
    root.querySelectorAll('.chip').forEach(n => n.remove());
    for (const v of values) {
      root.insertBefore(el('span', { class: 'chip' }, [
        el('span', { class: 'label', text: v }),
        el('button', { class: 'x', type: 'button', title: 'Убрать', text: '×', onclick: (e) => { e.stopPropagation(); remove(v); } }),
      ]), input);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && values.length) {
      remove(values[values.length - 1]);
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (text.includes(',')) { e.preventDefault(); add(text); }
  });
  root.addEventListener('click', () => input.focus());
  root.appendChild(input);

  return {
    get: () => values.slice(),
    set: (list) => { values = (list || []).map(v => String(v).toLowerCase()); render(); },
  };
}

// ---------------------------------------------------------------- emote picker

function createEmotePicker(root, { allowCustom, emptyText, searchPlaceholder, onChange }) {
  let selected = [];

  const chips = el('div', { class: 'chips' });
  const tabs = el('div', { class: 'ptabs' });
  const search = el('input', { class: 'input', placeholder: searchPlaceholder, spellcheck: 'false' });
  let provider = 'all';
  const clearBtn = el('button', { class: 'btn', type: 'button', text: 'Очистить выбор' });
  const results = el('div', { class: 'results' });
  const foot = el('div', { class: 'picker-foot' });

  root.append(chips, el('div', { class: 'picker-search' }, [search, clearBtn]), tabs, results, foot);

  function renderTabs(counts) {
    tabs.innerHTML = '';
    for (const p of PROVIDERS) {
      const count = counts[p.key] || 0;
      if (p.key !== 'all' && !state.emotes.some(e => e.provider === p.key)) continue; // провайдера нет совсем
      tabs.appendChild(el('button', {
        class: `ptab${p.key === provider ? ' active' : ''}`,
        type: 'button',
        onclick: () => { provider = p.key; renderResults(); },
      }, [document.createTextNode(p.label), el('span', { class: 'count', text: String(count) })]));
    }
  }

  function toggle(code) {
    const idx = selected.indexOf(code);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(code);
    renderChips();
    syncResultMarks();
    onChange();
  }

  function renderChips() {
    chips.innerHTML = '';
    if (!selected.length) {
      chips.appendChild(el('span', { class: 'empty', text: emptyText }));
      return;
    }
    for (const code of selected) {
      const emote = state.emoteByCode.get(code);
      chips.appendChild(el('span', { class: `chip${emote ? '' : ' custom'}`, title: emote ? code : `${code} — нет в загруженных эмоутах` }, [
        emote ? emoteImg(emote, code) : null,
        el('span', { class: 'label', text: code }),
        el('button', { class: 'x', type: 'button', title: 'Убрать', text: '×', onclick: () => toggle(code) }),
      ]));
    }
  }

  function syncResultMarks() {
    results.querySelectorAll('.emote').forEach(node => {
      node.classList.toggle('on', hasCode(selected, node.dataset.code));
    });
  }

  // Результаты поиска и сколько из них уже отрисовано (догружаются порциями при прокрутке)
  let matches = [];
  let shown = 0;

  function renderResults() {
    results.innerHTML = '';
    results.scrollTop = 0;
    matches = [];
    shown = 0;
    const query = search.value.trim().toLowerCase();

    if (!state.emotes.length) {
      results.appendChild(el('div', { class: 'note', text: 'Список эмоутов пуст. Запустите бота с заполненными ключами — эмоуты загрузятся автоматически.' }));
      foot.textContent = '';
      return;
    }

    let found = state.emotes;
    if (query) {
      const starts = [];
      const contains = [];
      for (const e of state.emotes) {
        if (e.lower.startsWith(query)) starts.push(e);
        else if (e.lower.includes(query)) contains.push(e);
      }
      found = starts.concat(contains);
    }

    const counts = { all: found.length };
    for (const e of found) counts[e.provider] = (counts[e.provider] || 0) + 1;
    renderTabs(counts);

    matches = provider === 'all' ? found : found.filter(e => e.provider === provider);

    if (!matches.length) {
      const where = provider === 'all' ? '' : ` в ${PROVIDER_LABEL[provider]}`;
      const msg = allowCustom && query && !found.length
        ? `Ничего не найдено. Нажмите Enter, чтобы добавить «${search.value.trim()}» как слово.`
        : `Ничего не найдено${where}.`;
      results.appendChild(el('div', { class: 'note', text: msg }));
      foot.textContent = '';
      return;
    }

    appendMore();
  }

  function appendMore() {
    if (shown >= matches.length) return;
    const frag = document.createDocumentFragment();
    for (const e of matches.slice(shown, shown + PAGE_SIZE)) {
      const node = el('div', { class: 'emote', title: `${e.code} · ${PROVIDER_LABEL[e.provider]}`, onclick: () => toggle(e.code) }, [
        emoteImg(e),
        el('span', { text: e.code }),
        provider === 'all' ? el('i', { class: `src src-${e.provider}`, text: PROVIDER_LABEL[e.provider] }) : null,
      ]);
      node.dataset.code = e.code;
      node.classList.toggle('on', hasCode(selected, e.code));
      frag.appendChild(node);
    }
    results.appendChild(frag);
    shown = Math.min(shown + PAGE_SIZE, matches.length);

    foot.textContent = shown < matches.length
      ? `Показано ${shown} из ${matches.length} — прокрутите вниз, чтобы загрузить ещё`
      : `Найдено: ${matches.length}`;
  }

  results.addEventListener('scroll', () => {
    if (results.scrollTop + results.clientHeight >= results.scrollHeight - 150) appendMore();
  });

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderResults, 80);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; renderResults(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = search.value.trim();
    if (!text) return;
    const exact = state.emoteByCode.get(text);
    if (exact) toggle(exact.code);
    else if (allowCustom) toggle(text);
    else return;
    search.select();
  });
  clearBtn.addEventListener('click', () => {
    if (!selected.length) return;
    selected = [];
    renderChips();
    syncResultMarks();
    onChange();
  });

  return {
    get: () => selected.slice(),
    set: (list) => { selected = (list || []).map(String); renderChips(); syncResultMarks(); },
    refresh: () => { renderChips(); renderResults(); },
  };
}

// ---------------------------------------------------------------- form

const keywords = createTagInput($('keywords'), { placeholder: 'добавить слово…', onChange: updateDirty });
const greetingPicker = createEmotePicker($('greetingPicker'), {
  allowCustom: false,
  emptyText: 'Не выбрано — приветствия показываться не будут',
  searchPlaceholder: 'Поиск эмоута…',
  onChange: updateDirty,
});
const blacklistPicker = createEmotePicker($('blacklistPicker'), {
  allowCustom: true,
  emptyText: 'Пусто',
  searchPlaceholder: 'Поиск эмоута или слово + Enter…',
  onChange: updateDirty,
});

// ---------------------------------------------------------------- animation picker (появление приветствия)

function createAnimationPicker(root, { onChange, onPick }) {
  let selected = ['none'];
  const tiles = new Map();

  function demoElement() {
    // в демо — эмоут приветствия, если он есть, иначе плашка «Аа»
    const code = (typeof greetingPicker !== 'undefined' && greetingPicker.get()[0]) || null;
    const emote = code && state.emoteByCode.get(code);
    if (emote) return el('img', { class: 'demo', src: emoteUrl(emote), alt: '' });
    return el('div', { class: 'demo letters', text: 'Аа' });
  }

  function play(tile, key) {
    const box = tile.querySelector('.demo-box');
    box.replaceChildren(demoElement());
    playGreetingAnimation(box.firstChild, key);
  }

  // переключить всю группу: если в ней выбрано не всё — выбрать всё, иначе снять
  function toggleGroup(groupKey) {
    const keys = (window.GREETING_ANIMATIONS || []).filter(a => a.group === groupKey && a.key !== 'none').map(a => a.key);
    const allOn = keys.every(k => selected.includes(k));
    selected = allOn ? selected.filter(k => !keys.includes(k)) : [...new Set([...selected, ...keys])];
    sync();
    onChange();
  }

  function render() {
    root.innerHTML = '';
    tiles.clear();
    const groups = window.GREETING_ANIMATION_GROUPS || [{ key: 'motion', label: '' }];
    for (const group of groups) {
      const items = (window.GREETING_ANIMATIONS || []).filter(a => (a.group || 'motion') === group.key);
      if (!items.length) continue;
      if (group.label) {
        root.appendChild(el('div', { class: 'anim-group-title' }, [
          el('span', { text: group.label }),
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'выбрать / снять все', onclick: () => toggleGroup(group.key) }),
        ]));
      }
      for (const anim of items) renderTile(anim);
    }
    sync();
  }

  function renderTile(anim) {
    const tile = el('div', { class: 'anim', title: anim.label }, [
      el('div', { class: 'demo-box' }),
      el('span', { text: anim.label }),
    ]);
    tile.addEventListener('mouseenter', () => play(tile, anim.key));
    tile.addEventListener('click', () => {
      const idx = selected.indexOf(anim.key);
      if (idx >= 0) selected.splice(idx, 1);
      else selected.push(anim.key);
      sync();
      play(tile, anim.key);
      onChange();
      if (idx < 0) onPick(anim.key); // только что выбрали — показать в предпросмотре
    });
    tiles.set(anim.key, tile);
    root.appendChild(tile);
    play(tile, 'none');
  }

  function sync() {
    for (const [key, tile] of tiles) tile.classList.toggle('on', selected.includes(key));
    const names = selected.map(k => (GREETING_ANIMATIONS.find(a => a.key === k) || {}).label).filter(Boolean);
    $('animFoot').textContent = !names.length
      ? 'Ничего не выбрано — приветствие появится сразу'
      : names.length === 1 ? `Всегда: ${names[0]}` : `Случайно из ${names.length}`;
  }

  render();
  return {
    get: () => selected.slice(),
    set: (list) => { selected = (list || []).filter(k => tiles.has(k)); sync(); },
    setAll: (on) => { selected = on ? [...tiles.keys()].filter(k => k !== 'none') : []; sync(); onChange(); },
    refreshDemos: () => { for (const tile of tiles.values()) play(tile, 'none'); },
  };
}

const animPicker = createAnimationPicker($('animPicker'), {
  onChange: updateDirty,
  onPick: (key) => { if ($('previewAuto').checked) previewGreeting(key); },
});
$('btnAnimAll').addEventListener('click', () => animPicker.setAll(true));
$('btnAnimNone').addEventListener('click', () => animPicker.setAll(false));

const simpleFields = Array.from(document.querySelectorAll('[data-key]'));

function readForm() {
  const out = {};
  for (const input of simpleFields) {
    const key = input.dataset.key;
    if (input.type === 'checkbox') out[key] = input.checked;
    else if (input.type === 'number' || input.type === 'range') out[key] = input.value === '' ? null : Number(input.value);
    else if (input.type === 'color') out[key] = input.value.toUpperCase();
    else out[key] = input.value.trim();
  }
  out.greetingKeywords = keywords.get();
  out.greetingEmotes = greetingPicker.get();
  out.emoteBlacklist = blacklistPicker.get();
  out.greetingAnimations = animPicker.get();
  for (const key of listKeys()) out[key] = listValues(key);
  return out;
}

// Группы галочек с data-list="<ключ>" → массив отмеченных value (в порядке на странице)
function listKeys() {
  return [...new Set([...document.querySelectorAll('[data-list]')].map(el => el.dataset.list))];
}
function listValues(key) {
  return [...document.querySelectorAll(`[data-list="${key}"]`)].filter(el => el.checked).map(el => el.value);
}

function writeForm(cfg) {
  setFontValue(cfg.greetingFontFamily);
  setFontValue(cfg.gameFontFamily, 'gameFont');
  setSelectValue($('editCamera'), cfg.editCameraSource);
  setSelectValue($('editAudio'), cfg.editAudioSource);
  for (const el of document.querySelectorAll('[data-list]')) {
    el.checked = Array.isArray(cfg[el.dataset.list]) && cfg[el.dataset.list].includes(el.value);
  }
  for (const input of simpleFields) {
    const value = cfg[input.dataset.key];
    if (input.type === 'checkbox') input.checked = value !== false;
    else input.value = value ?? '';
  }
  keywords.set(cfg.greetingKeywords);
  greetingPicker.set(cfg.greetingEmotes);
  blacklistPicker.set(cfg.emoteBlacklist);
  animPicker.set(Array.isArray(cfg.greetingAnimations) ? cfg.greetingAnimations : [cfg.greetingAnimation || 'none']);
  animPicker.refreshDemos(); // в демо на плитках — эмоут приветствия из конфига
  updateBoostRow();
  updateVolumeLabel();
  updateEditIntensityLabel();
}

function changedKeys() {
  if (!state.saved) return [];
  const form = readForm();
  const keys = [];
  for (const [key, value] of Object.entries(form)) {
    const saved = state.saved[key];
    const same = Array.isArray(value)
      ? sameList(value.map(String), (saved || []).map(String))
      : typeof value === 'boolean'
        ? value === (saved !== false)
        : String(value ?? '') === String(saved ?? '');
    if (!same) keys.push(key);
  }
  return keys;
}

function updateDirty() {
  const keys = changedKeys();
  $('savebar').classList.toggle('show', keys.length > 0);
  const dirtyTabs = new Set(keys.map(k => KEY_TAB[k]));
  document.querySelectorAll('[data-badge]').forEach(b => b.classList.toggle('show', dirtyTabs.has(b.dataset.badge)));
}

function isDirty() {
  return changedKeys().length > 0;
}

function applySavedConfig(cfg, { force = false } = {}) {
  const wasDirty = state.saved && isDirty();
  state.saved = cfg;
  if (force || !wasDirty) writeForm(cfg);
  updateOverlayLinks();
  updateBanner();
  updateDirty();
}

async function save() {
  if (state.busy || !isDirty()) return;
  state.busy = true;
  $('btnSave').disabled = true;
  try {
    const result = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.saved, ...readForm() }),
    });
    applySavedConfig(result.config, { force: true });
    toast(result.restarting ? 'Сохранено. Бот перезапускается…' : 'Сохранено', 'ok');
  } catch (err) {
    toast(`Не удалось сохранить: ${err.message}`, 'err');
  } finally {
    state.busy = false;
    $('btnSave').disabled = false;
  }
}

function updateBoostRow() {
  const on = $('boostOn').checked;
  $('boostScale').disabled = !on;
  $('boostRow').style.opacity = on ? '1' : '.45';
}

function updateOverlayLinks() {
  const port = (state.saved && state.saved.port) || 3000;
  const emotes = `http://127.0.0.1:${port}/emotes.html`;
  const greeting = `http://127.0.0.1:${port}/greeting.html`;
  const game = `http://127.0.0.1:${port}/game.html`;
  $('urlEmotes').textContent = emotes;
  $('urlGreeting').textContent = greeting;
  $('urlGame').textContent = game;
  $('openEmotes').href = emotes;
  $('openGreeting').href = greeting;
  $('openGame').href = game;
}

for (const input of simpleFields) {
  input.addEventListener('input', updateDirty);
  input.addEventListener('change', updateDirty);
}
document.querySelectorAll('[data-list]').forEach(el => el.addEventListener('change', updateDirty));
$('boostOn').addEventListener('change', updateBoostRow);

function updateVolumeLabel() {
  $('greetVolumeValue').textContent = `${$('greetVolume').value}%`;
}
$('greetVolume').addEventListener('input', updateVolumeLabel);

// Шрифт приветствия: Google-шрифты (список в /overlay/fonts.js) + все шрифты, установленные в Windows (/api/fonts).
let systemFonts = window.GREETING_FONTS ? GREETING_FONTS.system.slice() : ['Arial'];

function renderFontOptions() {
  for (const id of ['greetFont', 'gameFont']) {
    const select = $(id);
    const current = select.value;
    select.innerHTML = '';
    const google = window.GREETING_FONTS ? GREETING_FONTS.google : [];
    if (google.length) {
      select.appendChild(el('optgroup', { label: 'Google Fonts (с кириллицей)' }, google.map(name => el('option', { value: name, text: name }))));
    }
    select.appendChild(el('optgroup', { label: `Установленные в системе (${systemFonts.length})` }, systemFonts.map(name => {
      const option = el('option', { value: name, text: name });
      option.style.fontFamily = `"${name}", sans-serif`; // название сразу видно этим шрифтом
      return option;
    })));
    if (current) setFontValue(current, id);
  }
}

// Шрифт из конфига может отсутствовать в списке (удалён из системы) — показываем его отдельно, чтобы не потерять
function setFontValue(name, id = 'greetFont') {
  const select = $(id);
  if (name && ![...select.options].some(o => o.value === name)) {
    let missing = select.querySelector('optgroup[data-missing]');
    if (!missing) {
      missing = el('optgroup', { label: 'Не найден в системе', 'data-missing': '1' });
      select.prepend(missing);
    }
    missing.appendChild(el('option', { value: name, text: name }));
  }
  select.value = name || 'Arial';
}

renderFontOptions();
fetch('/api/fonts')
  .then(r => r.json())
  .then(data => {
    if (Array.isArray(data.system) && data.system.length) {
      systemFonts = data.system;
      renderFontOptions();
    }
  })
  .catch(() => {});

$('channel').addEventListener('blur', (e) => {
  // показываем, во что превратится ссылка, ещё до сохранения
  const v = e.target.value.trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/^#/, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();
  if (v !== e.target.value) { e.target.value = v; updateDirty(); }
});

$('toggleSecret').addEventListener('click', () => {
  const input = $('clientSecret');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Ссылка скопирована', 'ok');
    } catch {
      toast(text);
    }
  });
});

$('btnSave').addEventListener('click', save);
$('btnRevert').addEventListener('click', () => {
  writeForm(state.saved);
  updateDirty();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- preview

// Оверлеи открыты в iframe в режиме ?preview и получают те же события, что шлёт бот, через postMessage.
function fitStage(stage) {
  const frame = stage.querySelector('iframe');
  const w = Number(stage.dataset.w);
  const h = Number(stage.dataset.h);
  const scale = Math.min(1, stage.clientWidth / w) || 1;
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
  frame.style.transform = `scale(${scale})`;
  stage.style.height = Math.round(h * scale) + 'px';
}

const stages = [$('greetStage'), $('emoteStage'), $('gameStage')];
const stageObserver = new ResizeObserver(entries => entries.forEach(e => fitStage(e.target)));
stages.forEach(stage => { fitStage(stage); stageObserver.observe(stage); });

// Сообщения до загрузки iframe складываем и отправляем после load
const framePending = new Map();
function postToFrame(frameId, message) {
  const frame = $(frameId);
  if (!frame) return;
  if (frame.dataset.ready) frame.contentWindow.postMessage(message, location.origin);
  else framePending.set(frameId, [...(framePending.get(frameId) || []), message]);
}
for (const id of ['greetFrame', 'emoteFrame', 'gameFrame']) {
  const doc = $(id).contentDocument;
  if (doc && doc.readyState === 'complete' && doc.location.href !== 'about:blank') $(id).dataset.ready = '1';
  $(id).addEventListener('load', () => {
    $(id).dataset.ready = '1';
    for (const m of framePending.get(id) || []) $(id).contentWindow.postMessage(m, location.origin);
    framePending.delete(id);
  });
}

function emoteUrl(emote) {
  return `/cache/emotes/${emote.id}.${emote.format}`;
}

function pickRandom(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

function previewGreeting(forcedAnimation) {
  const form = readForm();
  const candidates = form.greetingEmotes.map(code => state.emoteByCode.get(code)).filter(Boolean);
  const emote = pickRandom(candidates) || state.emotes[0];
  if (!emote) {
    toast('Нет эмоутов для предпросмотра — запустите бота, чтобы они загрузились');
    return;
  }
  postToFrame('greetFrame', {
    type: 'greeting',
    replace: true,
    code: emote.code,
    url: emoteUrl(emote),
    user: $('previewName').value.trim() || 'Зритель_123',
    displayMs: $('previewHold').checked ? 24 * 3600 * 1000 : (form.greetingDisplaySeconds || 6) * 1000,
    style: {
      fontFamily: form.greetingFontFamily || 'Arial',
      fontSize: form.greetingFontSize || 36,
      bold: form.greetingBold,
      color: form.greetingTextColor,
      outlineColor: form.greetingOutlineColor,
      outlineWidth: form.greetingOutlineWidth ?? 0,
      shadow: form.greetingShadow,
      emoteSize: form.greetingEmoteSize || 300,
      template: form.greetingTemplate || '{user}',
      animations: forcedAnimation ? [forcedAnimation] : form.greetingAnimations,
    },
  });
}

let greetPreviewTimer = null;
document.querySelectorAll('[data-preview="greeting"]').forEach(input => {
  const replay = () => {
    if (!$('previewAuto').checked) return;
    clearTimeout(greetPreviewTimer);
    greetPreviewTimer = setTimeout(() => previewGreeting(), 250);
  };
  input.addEventListener('input', replay);
  input.addEventListener('change', replay);
});
$('btnPreviewGreeting').addEventListener('click', () => previewGreeting());
$('previewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') previewGreeting(); });

let previewUser = 0;
function sendPreviewEmote(emote, user) {
  const form = readForm();
  postToFrame('emoteFrame', {
    type: 'emote',
    code: emote.code,
    url: emoteUrl(emote),
    user: user || `viewer${++previewUser}`,
    displayDurationMs: (form.emoteDisplaySeconds || 6) * 1000,
    size: form.emoteSize || 150,
    boostOnSameFromDifferentUser: form.emoteBoostOnSameFromDifferentUser,
    boostScaleStep: Math.max(0, form.emoteBoostScalePercent ?? 20) / 100,
  });
}

function previewPool() {
  const blacklist = new Set(readForm().emoteBlacklist);
  return state.emotes.filter(e => !blacklist.has(e.code));
}

function withPool(fn) {
  const pool = previewPool();
  if (!pool.length) {
    toast('Нет эмоутов для предпросмотра — запустите бота, чтобы они загрузились');
    return;
  }
  fn(pool);
}

$('btnPreviewEmote').addEventListener('click', () => withPool(pool => sendPreviewEmote(pickRandom(pool))));
$('btnPreviewBurst').addEventListener('click', () => withPool(pool => {
  const user = `viewer${++previewUser}`;
  for (let i = 0; i < 5; i++) sendPreviewEmote(pickRandom(pool), user);
}));
$('btnPreviewBoost').addEventListener('click', () => withPool(pool => {
  const emote = pickRandom(pool);
  [0, 700, 1400].forEach(delay => setTimeout(() => sendPreviewEmote(emote), delay));
}));
$('btnPreviewClear').addEventListener('click', () => postToFrame('emoteFrame', { type: 'clear' }));

// ---------------------------------------------------------------- game (элемент «Текущая игра» и время в играх)

const SAMPLE_GAME = { game: { id: 'sample', name: 'Hollow Knight', boxArt: null }, seconds: 12 * 3600 + 34 * 60 + 56, running: true };
state.game = null; // ответ /api/game/state от бота или null

function gameStyleFromForm(form) {
  return {
    x: form.gameElementX ?? 60,
    y: form.gameElementY ?? 900,
    scale: form.gameElementScale || 100,
    template: form.gameElementTemplate || '{game}\n{time}',
    showBoxArt: form.gameShowBoxArt,
    showPaused: form.gameShowPaused,
    hideWhenNoGame: form.gameHideWhenNoGame,
    fontFamily: form.gameFontFamily || 'Arial',
    fontSize: form.gameFontSize || 36,
    bold: form.gameBold,
    color: form.gameTextColor,
    outlineColor: form.gameOutlineColor,
    outlineWidth: form.gameOutlineWidth ?? 0,
    shadow: form.gameShadow,
  };
}

// В предпросмотре — настоящая текущая игра, если стрим идёт, иначе пример
function previewGame() {
  const live = state.game && state.game.current && state.game.current.game ? state.game.current : null;
  const data = live || SAMPLE_GAME;
  postToFrame('gameFrame', { type: 'game', game: data.game, seconds: data.seconds, running: data.running, style: gameStyleFromForm(readForm()) });
  $('gamePreviewHint').textContent = live
    ? 'В предпросмотре — текущая категория стрима.'
    : 'Стрим не идёт — в предпросмотре пример. Обложка категории появится, когда начнётся эфир.';
}

let gamePreviewTimer = null;
document.querySelectorAll('[data-preview="game"]').forEach(input => {
  const replay = () => {
    clearTimeout(gamePreviewTimer);
    gamePreviewTimer = setTimeout(previewGame, 150);
  };
  input.addEventListener('input', replay);
  input.addEventListener('change', replay);
});

document.querySelectorAll('[data-align]').forEach(btn => {
  btn.addEventListener('click', () => postToFrame('gameFrame', { type: 'game-align', where: btn.dataset.align }));
});

// Элемент перетащили в предпросмотре — переносим координаты в поля (оверлей уже нарисовал его на новом месте)
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== $('gameFrame').contentWindow) return;
  const data = event.data || {};
  if (data.type !== 'game-move') return;
  $('gameX').value = data.x;
  $('gameY').value = data.y;
  updateDirty();
});

function formatGameTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// "12:30" → 12 ч 30 мин, "12" → 12 ч, "1:02:03" → с секундами
function parseGameTime(text) {
  const parts = String(text).trim().split(':');
  if (!parts[0] || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
  const [h, m = 0, s = 0] = parts.map(Number);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function renderGames() {
  const list = $('gamesList');
  list.replaceChildren();
  const data = state.game;

  if (!data) {
    $('gameStatus').textContent = state.bot === 'running' ? 'Нет ответа от бота' : 'Бот не запущен';
    list.appendChild(el('div', { class: 'note', text: 'Запустите бота, чтобы видеть и менять время в играх.' }));
    return;
  }

  const cur = data.current;
  const afk = data.idleMonitor ? '' : ' · детектор бездействия недоступен, AFK не учитывается';
  $('gameStatus').textContent = cur.game
    ? `${cur.running ? '▶ Идёт' : '⏸ Пауза (нет ввода)'}: ${cur.game.name}${afk}`
    : `Стрим не идёт — таймер стоит${afk}`;

  if (!data.games.length) {
    list.appendChild(el('div', { class: 'note', text: 'Пока пусто. Игра появится здесь, когда в эфире будет выбрана её категория.' }));
    return;
  }

  for (const g of data.games) {
    const isCurrent = cur.game && cur.game.id === g.id;
    const seconds = isCurrent ? cur.seconds : g.seconds;
    const input = el('input', { class: 'num', placeholder: 'Ч:ММ', value: formatGameTime(seconds).replace(/:\d\d$/, '') });
    const set = async (value) => {
      try {
        await api(`/api/game/playtime/${encodeURIComponent(g.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: value }),
        });
        toast(`${g.name}: ${formatGameTime(value)}`, 'ok');
        loadGameState();
      } catch (err) {
        toast(`Не удалось изменить время: ${err.message}`, 'err');
      }
    };
    const apply = () => {
      const value = parseGameTime(input.value);
      if (value === null) { toast('Формат времени: Ч:ММ, например 12:30', 'err'); return; }
      set(value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

    list.appendChild(el('div', { class: `game-row${isCurrent ? ' current' : ''}` }, [
      g.boxArt ? el('img', { src: g.boxArt.replace('{width}', '72').replace('{height}', '96'), alt: '' }) : el('div', { class: 'noart' }),
      el('div', { class: 'info' }, [
        el('div', { class: 'name', text: g.name || g.id }),
        el('div', { class: 'meta', text: g.lastPlayed ? `последний раз ${new Date(g.lastPlayed).toLocaleString('ru-RU')}` : 'ещё не играли' }),
      ]),
      el('span', { class: 'total', text: formatGameTime(seconds) }),
      input,
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Задать', onclick: apply }),
      el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: 'Сбросить',
        onclick: () => { if (confirm(`Сбросить время «${g.name}» в 0?`)) set(0); },
      }),
    ]));
  }
}

let gameStateLoading = false;
async function loadGameState() {
  if (gameStateLoading) return;
  gameStateLoading = true;
  const hadLive = !!(state.game && state.game.current && state.game.current.game);
  try {
    state.game = state.bot === 'stopped' ? null : await api('/api/game/state');
  } catch {
    state.game = null;
  } finally {
    gameStateLoading = false;
  }
  // не перерисовываем список, пока в нём вводят время
  if (!$('gamesList').contains(document.activeElement)) renderGames();
  const hasLive = !!(state.game && state.game.current && state.game.current.game);
  if (hasLive || hadLive) previewGame();
}

$('btnGameRefresh').addEventListener('click', loadGameState);
setInterval(() => {
  if (document.querySelector('.tab.active')?.dataset.tab === 'game' && !document.hidden) loadGameState();
}, 5000);

// ---------------------------------------------------------------- sounds (папка sounds)

let soundsData = null;
const soundPlayer = new Audio();
let playingRow = null;

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function stopSound() {
  soundPlayer.pause();
  if (playingRow) playingRow.classList.remove('playing');
  if (playingRow) playingRow.querySelector('.play').textContent = '▶';
  playingRow = null;
}
soundPlayer.addEventListener('ended', stopSound);

function playSound(row, file) {
  if (playingRow === row) { stopSound(); return; }
  stopSound();
  soundPlayer.src = '/' + file.path.split('/').map(encodeURIComponent).join('/');
  soundPlayer.volume = Math.min(1, Math.max(0, Number($('greetVolume').value) / 100)); // как в оверлее
  soundPlayer.play().catch(() => toast('Не удалось воспроизвести файл', 'err'));
  playingRow = row;
  row.classList.add('playing');
  row.querySelector('.play').textContent = '■';
}

function openSoundsFolder(folder) {
  api('/api/sounds/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: folder || '' }),
  }).catch(err => toast(`Не удалось открыть папку: ${err.message}`, 'err'));
}

function renderSounds() {
  const list = $('soundsList');
  stopSound();
  list.innerHTML = '';
  if (!soundsData) return;

  const folders = soundsData.folders;
  $('soundsSummary').textContent = !soundsData.exists
    ? 'Папки sounds нет — откройте её в проводнике, она создастся'
    : `${soundsData.total} файлов в ${folders.length} ${folders.length === 1 ? 'папке' : 'папках'}`;

  const query = $('soundsFilter').value.trim().toLowerCase();
  let shown = 0;
  for (const { folder, files } of folders) {
    const matched = query ? files.filter(f => f.name.toLowerCase().includes(query) || folder.toLowerCase().includes(query)) : files;
    if (!matched.length) continue;
    shown += matched.length;

    const details = el('details', { class: 'sound-folder' });
    if (query || folders.length === 1) details.open = true;
    details.appendChild(el('summary', {}, [
      el('span', { text: folder || 'sounds (корень)' }),
      el('span', { class: 'count', text: query ? `${matched.length} из ${files.length}` : String(files.length) }),
      el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', text: '📂', title: 'Открыть в проводнике',
        onclick: (e) => { e.preventDefault(); openSoundsFolder(folder); },
      }),
    ]));

    // строки создаём при первом раскрытии — в папках бывают сотни файлов
    const fill = () => {
      if (details.dataset.filled) return;
      details.dataset.filled = '1';
      for (const file of matched) {
        const row = el('div', { class: 'sound-row', title: file.path });
        row.append(
          el('button', { class: 'play', type: 'button', text: '▶', title: 'Прослушать', onclick: () => playSound(row, file) }),
          el('span', { class: 'name', text: file.name }),
          el('span', { class: 'size', text: formatSize(file.size) }),
        );
        details.appendChild(row);
      }
    };
    details.addEventListener('toggle', () => { if (details.open) fill(); });
    if (details.open) fill();
    list.appendChild(details);
  }

  if (!shown) {
    list.appendChild(el('div', { class: 'note', text: query ? 'Ничего не найдено' : 'В папке нет звуков (mp3, ogg, wav)' }));
  }
}

async function loadSounds({ reload = false } = {}) {
  try {
    const data = reload
      ? await api('/api/sounds/reload', { method: 'POST' })
      : await (await fetch('/api/sounds')).json();
    soundsData = data;
    renderSounds();
    if (reload) {
      toast(data.bot
        ? `Обновлено: ${data.total} файлов, бот подхватил ${data.bot.count}`
        : `Обновлено: ${data.total} файлов${state.bot === 'running' ? '' : ' (бот подхватит при запуске)'}`, 'ok');
    }
  } catch (err) {
    $('soundsSummary').textContent = 'Не удалось получить список звуков';
    if (reload) toast(err.message, 'err');
  }
}

$('btnSoundsReload').addEventListener('click', () => loadSounds({ reload: true }));
$('btnSoundsOpen').addEventListener('click', () => openSoundsFolder(''));
let soundsFilterTimer = null;
$('soundsFilter').addEventListener('input', () => {
  clearTimeout(soundsFilterTimer);
  soundsFilterTimer = setTimeout(renderSounds, 120);
});
$('greetVolume').addEventListener('input', () => {
  soundPlayer.volume = Math.min(1, Math.max(0, Number($('greetVolume').value) / 100));
});
loadSounds();

// ---------------------------------------------------------------- emotes

async function loadEmotes({ announce = false } = {}) {
  try {
    const data = await (await fetch('/api/emotes')).json();
    const list = [];
    for (const [code, info] of Object.entries(data || {})) {
      const id = typeof info === 'object' ? info.id : info;
      if (!id) continue;
      const obj = typeof info === 'object' ? info : {};
      list.push({ code, id, format: obj.format || 'png', lower: code.toLowerCase(), provider: detectProvider(obj.source, id) });
    }
    list.sort((a, b) => a.lower.localeCompare(b.lower));
    state.emotes = list;
    state.emoteByCode = new Map(list.map(e => [e.code, e]));
  } catch {
    toast('Не удалось загрузить список эмоутов', 'err');
  }

  $('emoteCount').textContent = state.emotes.length;
  $('emoteHint').textContent = state.emotes.length ? '' : '— запустите бота, чтобы загрузить';
  greetingPicker.refresh();
  blacklistPicker.refresh();
  animPicker.refreshDemos();
  if (announce) toast(`Эмоутов: ${state.emotes.length}`);
}

$('btnRefreshEmotes').addEventListener('click', () => loadEmotes({ announce: true }));

// ---------------------------------------------------------------- bot status

const STATUS_TEXT = { stopped: 'Остановлен', starting: 'Запуск…', running: 'Работает' };

// Что известно о текущем запуске бота (из его лога). Сбрасывается при каждом старте.
function freshRun(started) {
  return { started, error: null, emotes: null, chat: null, offline: new Set(), noGreetEmote: false };
}
state.run = freshRun(false);

function twitchSummary() {
  const run = state.run;
  if (state.bot === 'stopped') return null;
  if (run.error) return { level: 'err', text: run.error };
  // недоступные провайдеры (7TV без VPN и т.п.): эмоуты взяты из кэша — работает, но стоит знать
  const providers = [...new Set([...run.offline].map(s => s.split(' ')[0]))];
  const offline = providers.length ? `, ${providers.join('/')} недоступен — эмоуты из кэша` : '';
  const noGreet = run.noGreetEmote ? ', эмоут приветствия не найден' : '';
  if (run.chat) {
    const level = offline || noGreet ? 'warn' : 'ok';
    return { level, text: `в чате ${run.chat}${run.emotes ? `, эмоутов: ${run.emotes}` : ''}${offline}${noGreet}` };
  }
  if (run.emotes) return { level: 'warn', text: `эмоутов: ${run.emotes}, подключение к чату…` };
  if (run.started) return { level: 'warn', text: 'загрузка эмоутов…' };
  return null;
}

function renderStatus() {
  const summary = twitchSummary();
  $('status').dataset.state = summary && summary.level === 'err' ? 'error' : state.bot;
  $('statusMain').textContent = STATUS_TEXT[state.bot];
  $('statusSub').textContent = summary ? `· ${summary.text}` : '';

  $('btnStart').disabled = state.bot !== 'stopped';
  $('btnStop').disabled = state.bot === 'stopped';
  $('btnRestart').disabled = state.bot === 'starting';
  $('btnResetSession').disabled = state.bot !== 'running';
  updateBanner();
}

function setBotState(running, starting) {
  const next = running ? 'running' : starting ? 'starting' : 'stopped';
  if (next === state.bot) return;
  // stopped -> running без starting бывает, когда панель открыли при уже работающем боте:
  // что с Twitch, мы тогда не знаем, поэтому подпись не показываем, пока не придут строки лога.
  if (next === 'starting') state.run = freshRun(true);
  else if (next === 'stopped' || state.bot === 'stopped') state.run = freshRun(false);
  state.bot = next;
  renderStatus();
  if (document.querySelector('.tab.active')?.dataset.tab === 'game') loadGameState();
}

// Разбираем лог бота, чтобы показать понятный статус подключения к Twitch.
// Ошибка остаётся до следующего запуска: бот может зайти в чат анонимно и с неверными ключами.
function inspectLog(line) {
  const run = state.run;
  let m;
  if (/invalid client|missing client id|Twitch token error: 4/i.test(line)) {
    run.error = 'неверные Client ID / Secret';
  } else if ((m = line.match(/Twitch user not found for login: ?(.*)/))) {
    run.error = m[1].trim() ? `канал «${m[1].trim()}» не найден` : 'канал не указан';
  } else if (/\[BOOT\] Startup failed/.test(line)) {
    run.error = 'ошибка запуска, см. консоль';
  } else if (/EADDRINUSE/.test(line)) {
    run.error = 'порт оверлеев занят другой программой';
  } else if ((m = line.match(/\[EMOTES\] Total loaded: (\d+)/))) {
    run.emotes = Number(m[1]);
    run.error = null; // повторная загрузка после ошибки прошла успешно
  } else if ((m = line.match(/\[EMOTES\] (\S+ \S+) unavailable, using \d+ cached emotes/))) {
    run.offline.add(m[1]);
  } else if (/\[GREET\] None of the greeting emotes are available/.test(line)) {
    run.noGreetEmote = true;
  } else if ((m = line.match(/\[TMI\] Joined (#\S+)/))) {
    run.chat = m[1];
  } else {
    return;
  }
  renderStatus();
}

async function botAction(path, message) {
  try {
    await api(path, { method: 'POST' });
    if (message) toast(message);
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('btnStart').addEventListener('click', () => {
  setBotState(false, true);
  botAction('/api/start');
});
$('btnStop').addEventListener('click', () => botAction('/api/stop', 'Бот остановлен'));
$('btnRestart').addEventListener('click', () => {
  setBotState(false, true);
  botAction('/api/restart');
});
$('btnResetSession').addEventListener('click', async () => {
  if (!confirm('Сбросить приветствия текущего стрима? Все зрители смогут поздороваться заново.')) return;
  try {
    const r = await api('/api/reset-session', { method: 'POST' });
    toast(`Приветствия сброшены (было: ${r.greetedCount ?? 0})`, 'ok');
  } catch (err) {
    toast(`Не удалось сбросить: ${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------- banner

function updateBanner() {
  const banner = $('banner');
  const cfg = state.saved || {};
  const missing = [];
  if (!cfg.channel) missing.push('канал');
  if (!cfg.twitchClientId) missing.push('Client ID');
  if (!cfg.twitchClientSecret) missing.push('Client Secret');

  const summary = twitchSummary();
  let title = null;
  let body = '';
  let kind = 'warn';
  if (state.saved && missing.length) {
    title = 'Бот не настроен';
    body = `Не заполнено: ${missing.join(', ')}. Без этого эмоуты не загрузятся.`;
  } else if (summary && summary.level === 'err') {
    kind = 'err';
    title = 'Проблема с подключением к Twitch';
    body = `${summary.text[0].toUpperCase()}${summary.text.slice(1)}. Проверьте настройки.`;
  }

  banner.className = `banner ${kind}${title ? ' show' : ''}`;
  if (title) {
    $('bannerText').replaceChildren(el('b', { text: title }), document.createTextNode(body));
    $('bannerAction').textContent = 'Открыть настройки';
    $('bannerAction').onclick = () => showTab('connection');
  }
}

// ---------------------------------------------------------------- console

const consoleEl = $('console');

function lineClass(text) {
  if (/\[ERROR\]|error|failed|ошибк/i.test(text)) return 'err';
  if (/\[SPAM\]|warn/i.test(text)) return 'warn';
  if (/^\[CHAT\]|\binfo: \[#/.test(text)) return 'chat';
  if (/^\[EMOTE\]/.test(text)) return 'emote';
  if (/^\[GREET\]/.test(text)) return 'greet';
  if (/^\[(PANEL|WS)\]/.test(text)) return 'panel';
  return '';
}

function lineVisible(node) {
  const filter = $('logFilter').value.trim().toLowerCase();
  if (!$('logChat').checked && node.classList.contains('chat')) return false;
  return !filter || node.textContent.toLowerCase().includes(filter);
}

function addLog(message) {
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
  for (const raw of String(message).split(/\r?\n/)) {
    const text = raw.trimEnd();
    if (!text) continue;
    inspectLog(text);
    const node = el('div', { class: `line ${lineClass(text)}`, text });
    node.hidden = !lineVisible(node);
    consoleEl.appendChild(node);
  }
  while (consoleEl.childElementCount > MAX_LOG_LINES) consoleEl.firstElementChild.remove();
  if ($('logAutoscroll').checked && atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function refilterLog() {
  for (const node of consoleEl.children) node.hidden = !lineVisible(node);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

$('logFilter').addEventListener('input', refilterLog);
$('logChat').addEventListener('change', refilterLog);
$('btnClearLog').addEventListener('click', () => { consoleEl.innerHTML = ''; });

// ---------------------------------------------------------------- tabs

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.page === name));
  try { localStorage.setItem('emotesbot.tab', name); } catch {}
  if (name === 'console') consoleEl.scrollTop = consoleEl.scrollHeight;
  if (name === 'greetings' && state.emotes.length) setTimeout(() => previewGreeting(), 150);
  if (name === 'game') { previewGame(); loadGameState(); }
  if (name === 'edit') { loadEditSources(); pollEditState(); }
  stages.forEach(fitStage);
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------------------------------------------------------------- эдит (edit.js у бота)

// В выпадающем списке может не быть сохранённого значения (OBS ещё не ответил, источник переименован) — добавим его
function setSelectValue(select, value, label) {
  if (!select) return;
  if (value && ![...select.options].some(o => o.value === value)) {
    select.appendChild(el('option', { value, text: label || `${value} (нет в OBS)` }));
  }
  if (!select.querySelector('option[value=""]')) select.prepend(el('option', { value: '', text: '— не выбрано —' }));
  select.value = value || '';
}

function fillSourceSelect(select, items, current) {
  select.replaceChildren(el('option', { value: '', text: '— не выбрано —' }));
  for (const item of items) select.appendChild(el('option', { value: item.name, text: item.name }));
  setSelectValue(select, current);
}

async function loadEditSources() {
  const hint = $('editSourcesHint');
  hint.textContent = 'Спрашиваю OBS…';
  try {
    const res = await fetch('/api/edit/sources');
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    fillSourceSelect($('editCamera'), data.video, $('editCamera').value || (state.saved && state.saved.editCameraSource));
    fillSourceSelect($('editAudio'), data.audio, $('editAudio').value || (state.saved && state.saved.editAudioSource));
    hint.textContent = `В OBS: ${data.video.length} видео, ${data.audio.length} со звуком`;
    updateDirty();
  } catch (err) {
    hint.textContent = /Бот не запущен/.test(err.message)
      ? 'Запустите бота — список берётся из OBS через него.'
      : `Не получилось: ${err.message}. Проверьте, что эдит включён и настройки сохранены.`;
  }
}

function updateEditIntensityLabel() {
  $('editIntensityValue').textContent = `${$('editIntensity').value}%`;
}
$('editIntensity').addEventListener('input', updateEditIntensityLabel);

let editPollTimer = null;
async function pollEditState() {
  clearTimeout(editPollTimer);
  if (!document.querySelector('.page[data-page="edit"].active')) return; // опрашиваем только на этой вкладке
  try {
    const res = await fetch('/api/edit/state');
    const s = await res.json();
    if (res.status === 409) {
      $('editObs').textContent = 'бот не запущен';
      $('editRun').textContent = '—';
      $('editBpm').textContent = '—';
    } else {
      $('editObs').textContent = !s.enabled ? 'эдит выключен' : s.obs.connected ? 'подключён ✓' : (s.obs.error || 'подключаюсь…');
      $('editObs').style.color = s.obs.connected ? 'var(--ok)' : s.enabled ? 'var(--warn)' : '';
      $('editLevel').style.width = s.level == null ? '0' : `${Math.min(100, Math.round(Math.sqrt(s.level) * 100))}%`;
      $('editBpm').textContent = s.bpm ? `${s.bpm} BPM${s.locked ? '' : ' ?'}` : (s.level == null ? 'нет звука' : 'ищу бит…');
      $('editBpm').title = s.locked ? 'темп найден, эффекты идут по сетке битов' : 'темп ещё не найден — эффекты идут по отдельным ударам';
      $('editBeat').style.opacity = s.beatPhase == null ? 0 : Math.max(0, 1 - s.beatPhase * 2.5);
      $('editRun').textContent = s.running ? `идёт, осталось ${s.remaining} с${s.power > 1 ? ` · сила ×${s.power.toFixed(2)}` : ''}` : s.cooldown ? `отдыхает ${s.cooldown} с` : 'готов';
      $('editRun').style.color = s.running ? 'var(--ok)' : '';
    }
  } catch {}
  pollRewardState();
  editPollTimer = setTimeout(pollEditState, 250);
}

// ---- награда за баллы: вход в Twitch (код на twitch.tv/activate) и состояние награды
let rewardPollAt = 0;
function renderReward(r) {
  const signedIn = Boolean(r && r.signedIn);
  $('rewardAccount').textContent = !r ? 'бот не запущен' : signedIn ? r.login : r.pending ? 'ждём ввода кода…' : 'вход не выполнен';
  $('rewardAccount').style.color = signedIn ? 'var(--ok)' : '';
  $('btnRewardLogin').hidden = signedIn || Boolean(r && r.pending);
  $('btnRewardLogout').hidden = !signedIn;
  $('rewardCode').hidden = !(r && r.pending);
  if (r && r.pending) {
    $('rewardCodeText').textContent = r.pending.code;
    $('rewardUri').href = r.pending.uri;
  }
  let status = '—', color = '';
  if (r && r.error) { status = r.error; color = 'var(--err)'; }
  else if (r && signedIn && !r.enabled) status = 'выключена (скрыта на канале)';
  else if (r && signedIn && r.reward) {
    status = `«${r.reward.title}», ${r.reward.cost} баллов — ${r.reward.paused ? 'на паузе: эдит сейчас не запустится' : r.listening ? 'активна' : 'подключаюсь…'}`;
    color = r.reward.paused ? 'var(--warn)' : r.listening ? 'var(--ok)' : '';
  } else if (r && signedIn) status = 'настраиваю…';
  else if (r) status = 'войдите в Twitch, чтобы бот создал награду';
  $('rewardStatus').textContent = status;
  $('rewardStatus').style.color = color;
}
async function pollRewardState() {
  if (Date.now() - rewardPollAt < 1000) return;
  rewardPollAt = Date.now();
  try {
    const res = await fetch('/api/reward/state');
    renderReward(res.status === 409 ? null : await res.json());
  } catch {}
}
$('btnRewardLogin').addEventListener('click', async () => {
  try {
    const r = await api('/api/reward/login', { method: 'POST' });
    renderReward(r);
    window.open(r.pending.uri, '_blank', 'noopener');
  } catch (err) {
    toast(`Вход не начался: ${err.message}`, 'err');
  }
});
$('btnRewardCancel').addEventListener('click', async () => {
  try { renderReward(await api('/api/reward/logout', { method: 'POST' })); } catch {}
});
$('btnRewardLogout').addEventListener('click', async () => {
  if (!confirm('Выйти из Twitch? Награда на канале будет скрыта.')) return;
  try {
    renderReward(await api('/api/reward/logout', { method: 'POST' }));
    toast('Вы вышли из Twitch, награда скрыта', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('btnEditSources').addEventListener('click', loadEditSources);
$('btnEditTest').addEventListener('click', async () => {
  try {
    await api('/api/edit/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration: 15 }) });
    toast('Эдит запущен на 15 секунд', 'ok');
  } catch (err) {
    toast(`Эдит не запустился: ${err.message}`, 'err');
  }
});
$('btnEditStop').addEventListener('click', () => botAction('/api/edit/stop', 'Эдит остановлен'));
$('toggleObsPassword').addEventListener('click', () => {
  const input = $('obsPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// ---------------------------------------------------------------- websocket

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data.type) {
      case 'config': applySavedConfig(data.config); break;
      case 'status': setBotState(data.running, data.starting); break;
      case 'log': addLog(data.message); break;
      case 'emotes-updated': loadEmotes(); break;
      case 'update-progress': onUpdateProgress(data); break;
      case 'update-installing': onUpdateInstalling(data); break;
      case 'update-error': onUpdateError(data.error); break;
    }
  };

  ws.onopen = () => {
    if (update.installing) loadVersion(); // панель перезапустилась после обновления
  };

  ws.onclose = () => {
    addLog('[PANEL] Нет связи с панелью, переподключение…');
    setBotState(false, false);
    setTimeout(connect, 2000);
  };
}

// ---------------------------------------------------------------- версия и обновления (updates.js)

const update = { info: null, installing: false };
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;
}

async function loadVersion() {
  try {
    const v = await (await fetch('/api/version')).json();
    $('versionTag').textContent = `v${v.version}`;
    $('versionTag').title = v.repo ? `Проверить обновления (github.com/${v.repo})` : 'Проверка обновлений не настроена';
    // итог обновления сервер отдаёт 10 минут — показываем один раз на этом компьютере
    let shown = null;
    try { shown = localStorage.getItem('emotesbot.updateShown'); } catch {}
    if (v.lastUpdate && v.lastUpdate.at !== shown) {
      if (v.lastUpdate.ok) toast(`Обновлено до v${v.lastUpdate.to}`, 'ok');
      else toast(`Обновление не удалось: ${v.lastUpdate.error || 'неизвестная ошибка'}`, 'err');
      try { localStorage.setItem('emotesbot.updateShown', v.lastUpdate.at); } catch {}
    }
    if (update.installing) {
      update.installing = false;
      closeUpdateModal();
      checkForUpdate({ force: true }); // кнопка «Доступна…» больше не нужна
    }
  } catch {}
}

async function checkForUpdate({ force = false, announce = false } = {}) {
  try {
    const res = await fetch(`/api/update/check${force ? '?force=1' : ''}`);
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    update.info = info;
    $('btnUpdate').hidden = !info.hasUpdate;
    if (info.hasUpdate) $('btnUpdate').textContent = `⬆ Доступна v${info.latest}`;
    if (announce) {
      if (!info.enabled) toast('Проверка обновлений не настроена (нет репозитория в package.json)');
      else if (info.hasUpdate) openUpdateModal();
      else toast(`У вас последняя версия (v${info.current})`, 'ok');
    }
  } catch (err) {
    if (announce) toast(`Не удалось проверить обновления: ${err.message}`, 'err');
  }
}

// Описание релиза — markdown из CHANGELOG.md. Разбираем только то, что там бывает: заголовки, **жирный**,
// `код`, списки. Текст вставляется через textContent, поэтому HTML из описания не выполнится.
function renderNotes(container, markdown) {
  container.replaceChildren();
  for (const rawLine of markdown.replace(/\r/g, '').split('\n')) {
    const heading = rawLine.match(/^#{1,6}\s+(.*)/);
    const bullet = rawLine.match(/^\s*[-*]\s+(.*)/);
    const text = heading ? heading[1] : bullet ? bullet[1] : rawLine;
    const line = el('div', { class: bullet ? 'note-li' : heading ? 'note-h' : '' });
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith('**')) line.appendChild(el('b', { text: part.slice(2, -2) }));
      else if (part.startsWith('`')) line.appendChild(el('code', { text: part.slice(1, -1) }));
      else line.appendChild(document.createTextNode(part));
    }
    if (!text.trim()) line.innerHTML = '&nbsp;';
    container.appendChild(line);
  }
}

function openUpdateModal() {
  const info = update.info;
  if (!info) return;
  $('updateTitle').textContent = `Доступна версия ${info.latest}`;
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString('ru-RU') : '';
  $('updateSub').textContent = `У вас v${info.current}${date ? ` · релиз от ${date}` : ''}${info.asset ? ` · архив ${formatBytes(info.asset.size)}` : ''}`;
  renderNotes($('updateNotes'), info.notes.trim() || 'Описание изменений не указано.');
  $('updateGithub').href = info.htmlUrl || `https://github.com/${info.repo}/releases`;
  $('updateProgress').hidden = true;
  $('updateBar').style.width = '0';
  const canInstall = info.canInstall && info.asset;
  $('updateInstall').hidden = !canInstall;
  $('updateInstall').disabled = false;
  $('updateLater').disabled = false;
  setUpdateStatus(canInstall
    ? 'Бот остановится на полминуты, настройки, звуки и кэш останутся на месте.'
    : !info.asset
      ? 'В релизе нет архива для установки — скачайте новую версию со страницы на GitHub.'
      : 'Эта копия запущена не через EmotesBotTray.exe, поэтому обновиться сама не может. Скачайте архив со страницы на GitHub.');
  $('updateModal').hidden = false;
}

function closeUpdateModal() {
  $('updateModal').hidden = true;
}

function setUpdateStatus(text, kind = '') {
  $('updateStatus').textContent = text;
  $('updateStatus').className = `modal-status ${kind}`;
}

async function installUpdate() {
  $('updateInstall').disabled = true;
  $('updateLater').disabled = true;
  $('updateProgress').hidden = false;
  setUpdateStatus('Скачиваю обновление…');
  try {
    await api('/api/update/install', { method: 'POST' });
  } catch (err) {
    onUpdateError(err.message);
  }
}

function onUpdateProgress({ received, total }) {
  $('updateProgress').hidden = false;
  const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
  $('updateBar').style.width = `${pct}%`;
  setUpdateStatus(`Скачиваю обновление… ${formatBytes(received)}${total ? ` из ${formatBytes(total)} (${pct}%)` : ''}`);
}

function onUpdateInstalling({ version }) {
  update.installing = true;
  $('updateBar').style.width = '100%';
  setUpdateStatus(`Устанавливаю v${version}… Панель перезапустится сама, не закрывайте эту страницу.`);
}

function onUpdateError(message) {
  update.installing = false;
  $('updateInstall').disabled = false;
  $('updateLater').disabled = false;
  setUpdateStatus(`Не получилось: ${message}`, 'err');
}

$('btnUpdate').addEventListener('click', openUpdateModal);
$('versionTag').addEventListener('click', () => checkForUpdate({ force: true, announce: true }));
$('updateLater').addEventListener('click', closeUpdateModal);
$('updateInstall').addEventListener('click', installUpdate);
$('updateModal').addEventListener('click', (e) => {
  if (e.target === $('updateModal') && !update.installing && !$('updateLater').disabled) closeUpdateModal();
});
setInterval(() => checkForUpdate(), UPDATE_CHECK_EVERY_MS);

// ---------------------------------------------------------------- init

(async () => {
  let initialTab = 'connection';
  try { initialTab = localStorage.getItem('emotesbot.tab') || initialTab; } catch {}
  const savedTab = document.querySelector(`.tab[data-tab="${initialTab}"]`);
  if (!savedTab || savedTab.hidden) initialTab = 'connection';
  showTab(initialTab);
  renderStatus();

  await loadEmotes();
  try {
    applySavedConfig(await (await fetch('/api/config')).json(), { force: true });
  } catch {
    toast('Не удалось загрузить настройки', 'err');
  }

  if (state.saved && (!state.saved.channel || !state.saved.twitchClientId || !state.saved.twitchClientSecret)) {
    showTab('connection');
  }

  if (document.querySelector('.tab.active')?.dataset.tab === 'greetings') previewGreeting();
  if (document.querySelector('.tab.active')?.dataset.tab === 'game') previewGame();

  connect();
  loadVersion();
  checkForUpdate();
})();
