// Награда за баллы канала для эдита. Стример один раз входит в Twitch (Device Code Flow: код вводится на
// twitch.tv/activate, адрес перенаправления в приложении не нужен), бот сам создаёт награду, слушает активации
// через EventSub WebSocket и отмечает каждую: эдит пошёл — FULFILLED, не смог — CANCELED (баллы возвращаются).
// Пока бот выключен, награда скрыта; пока эдит не может запуститься (OBS не подключён) — на паузе.
// Управлять (менять, ставить на паузу, возвращать баллы) Twitch разрешает только наградами, созданными тем же
// Client ID, поэтому награду создаёт бот, а не стример вручную.
const fs = require("fs");
const EventEmitter = require("events");
const WebSocket = require("ws");

// Адреса можно подменить для локальных тестов (заглушка Twitch)
const ID_BASE = process.env.TWITCH_ID_BASE || "https://id.twitch.tv/oauth2";
const HELIX_BASE = process.env.TWITCH_HELIX_BASE || "https://api.twitch.tv/helix";
const EVENTSUB_URL = process.env.TWITCH_EVENTSUB_URL || "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

const SCOPES = "channel:manage:redemptions";
const REDEMPTION_EVENT = "channel.channel_points_custom_reward_redemption.add";
const HTTP_TIMEOUT_MS = 15000;
const CHECK_MS = 5000; // как часто проверять, может ли эдит запуститься (пауза награды) и не пора ли повторить синхронизацию
const RETRY_SYNC_MS = 60000;
const REWARD_PROMPT = "Вебка стримера на время превращается в эдит под музыку. Повторная покупка продлевает и усиливает эффект.";

class TwitchApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {} // не rmSync: в Node 24 он молча не удаляет файлы по путям с кириллицей
}

async function twitchFetch(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new TwitchApiError(res.status, (data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}

const form = (params) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
});

// Ошибка Twitch → понятный текст для панели
function describe(err) {
  if (err instanceof TwitchApiError) {
    if (err.status === 403) return "Twitch не дал управлять наградой: баллы канала есть только у компаньонов и партнёров";
    return `Twitch ответил ${err.status}: ${err.message}`;
  }
  if (err.name === "TimeoutError") return "Twitch не ответил вовремя";
  return err.message;
}

class RewardManager extends EventEmitter {
  constructor({ file, log, isAvailable }) {
    super();
    this.file = file;
    this.log = log;
    this.isAvailable = isAvailable; // может ли эдит запуститься прямо сейчас
    this.auth = this.loadAuth(); // { clientId, accessToken, refreshToken, expiresAt, userId, login, rewardIds: { key: id } }
    this.cfg = null;
    this.login = null; // идущий вход: { userCode, uri, expiresAt, deviceCode, interval }
    this.error = null;
    this.rewards = new Map();      // key → награда, как она сейчас на Twitch
    this.rewardErrors = new Map(); // key → ошибка этой награды (например, такое название уже занято)
    this.paused = null;
    this.pendingPause = 0;
    this.ws = null;
    this.sessionId = null;
    this.wsFailures = 0;
    this.seen = []; // id сообщений EventSub: Twitch может прислать одно и то же дважды
    this.inFlight = new Set(); // активации, которые сейчас обрабатываются
    this.syncing = null;
    this.syncAgain = false;
    this.lastSyncAt = 0;
    this.refreshing = null;
    this.stopped = false;
    this.timer = setInterval(() => this.check(), CHECK_MS);
  }

  // ---- токены
  loadAuth() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return a && a.accessToken && a.refreshToken ? a : null;
    } catch {
      return null;
    }
  }

  saveAuth() {
    if (this.auth) fs.writeFileSync(this.file, JSON.stringify(this.auth, null, 2), "utf8");
  }

  dropAuth(reason) {
    this.auth = null;
    removeFile(this.file);
    this.rewards.clear();
    this.rewardErrors.clear();
    this.paused = null;
    this.closeSocket();
    this.error = reason || null;
    if (reason) this.log(`[REWARD] ${reason}`);
  }

  async token() {
    if (!this.auth) throw new Error("Вход в Twitch не выполнен");
    if (this.auth.expiresAt - Date.now() < 5 * 60 * 1000) await this.refresh();
    return this.auth.accessToken;
  }

  // Обновление токена — строго по одному: refresh token у Twitch одноразовый
  refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const a = this.auth;
        try {
          const params = { grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: a.clientId };
          if (this.cfg && this.cfg.clientSecret) params.client_secret = this.cfg.clientSecret;
          const t = await twitchFetch(`${ID_BASE}/token`, form(params));
          if (this.auth !== a) return;
          a.accessToken = t.access_token;
          a.refreshToken = t.refresh_token || a.refreshToken;
          a.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
          this.saveAuth();
        } catch (err) {
          if (err instanceof TwitchApiError && (err.status === 400 || err.status === 401) && this.auth === a) {
            this.dropAuth("Вход в Twitch истёк — войдите заново на вкладке «Эдит»");
          }
          throw err;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  async helix(method, pathname, body, { timeout } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      try {
        return await twitchFetch(`${HELIX_BASE}${pathname}`, {
          method,
          headers: { "Client-Id": this.auth.clientId, Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
        });
      } catch (err) {
        if (err.status === 401 && attempt === 0) { await this.refresh(); continue; }
        throw err;
      }
    }
  }

  // ---- настройки
  applyConfig(cfg) {
    const list = Array.isArray(cfg.editRewards) ? cfg.editRewards : [];
    this.cfg = {
      clientId: cfg.twitchClientId || "",
      clientSecret: cfg.twitchClientSecret || "",
      channel: String(cfg.channel || "").trim().toLowerCase(),
      rewards: list.filter(r => r && r.key).map(r => ({
        key: String(r.key),
        title: String(r.title || "").trim().slice(0, 45) || "Эдит на вебке",
        cost: Math.max(1, Math.round(Number(r.cost) || 5000)),
        enabled: cfg.editEnabled === true && r.enabled !== false,
      })),
    };
    // прежняя версия хранила одну награду (rewardId) — она становится первой в списке
    if (this.auth && !this.auth.rewardIds) {
      this.auth.rewardIds = this.auth.rewardId && this.cfg.rewards[0] ? { [this.cfg.rewards[0].key]: this.auth.rewardId } : {};
      delete this.auth.rewardId;
      this.saveAuth();
    }
    if (this.auth && this.auth.clientId !== this.cfg.clientId) {
      this.dropAuth("Client ID изменился — войдите в Twitch заново");
    } else if (this.auth && this.cfg.channel && this.auth.login.toLowerCase() !== this.cfg.channel) {
      this.dropAuth(`Канал сменился на ${this.cfg.channel} — войдите в Twitch под его аккаунтом`);
    }
    this.scheduleSync();
  }

  // ---- вход (Device Code Flow)
  async startLogin() {
    if (!this.cfg || !this.cfg.clientId) throw new Error("Сначала укажите Client ID на вкладке «Подключение»");
    this.login = null;
    const d = await twitchFetch(`${ID_BASE}/device`, form({ client_id: this.cfg.clientId, scopes: SCOPES }));
    const login = {
      userCode: d.user_code,
      uri: d.verification_uri,
      deviceCode: d.device_code,
      expiresAt: Date.now() + (d.expires_in || 1800) * 1000,
      interval: Math.max(1, d.interval || 5),
    };
    this.login = login;
    this.error = null;
    this.log(`[REWARD] Waiting for Twitch sign-in: code ${login.userCode} at ${login.uri}`);
    this.pollLogin(login);
    return this.state();
  }

  cancelLogin() {
    this.login = null;
  }

  async pollLogin(login) {
    const clientId = this.cfg.clientId;
    while (this.login === login && Date.now() < login.expiresAt) {
      await sleep(login.interval * 1000);
      if (this.login !== login) return;
      let t;
      try {
        t = await twitchFetch(`${ID_BASE}/token`, form({
          client_id: clientId, scopes: SCOPES, device_code: login.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }));
      } catch (err) {
        if (!(err instanceof TwitchApiError) || /authorization_pending/i.test(err.message)) continue; // ещё не ввели код / сеть моргнула
        if (/slow_down/i.test(err.message)) { login.interval += 5; continue; }
        if (this.login === login) {
          this.login = null;
          this.error = /invalid device code|denied/i.test(err.message) ? "Вход отменён" : `Вход не удался: ${err.message}`;
        }
        return;
      }
      if (this.login !== login) return;
      this.login = null;
      try {
        const v = await twitchFetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${t.access_token}` } });
        if (this.cfg.channel && v.login.toLowerCase() !== this.cfg.channel) {
          this.revoke(clientId, t.access_token);
          this.error = `Вы вошли как ${v.login}, а канал бота — ${this.cfg.channel}. Войдите под аккаунтом канала`;
          this.log(`[REWARD] ${this.error}`);
          return;
        }
        this.auth = {
          clientId, accessToken: t.access_token, refreshToken: t.refresh_token,
          expiresAt: Date.now() + (t.expires_in || 3600) * 1000, userId: v.user_id, login: v.login, rewardIds: {},
        };
        this.saveAuth();
        this.error = null;
        this.log(`[REWARD] Signed in to Twitch as ${v.login}`);
        this.scheduleSync();
      } catch (err) {
        this.error = `Вход не удался: ${describe(err)}`;
      }
      return;
    }
    if (this.login === login) {
      this.login = null;
      this.error = "Код входа истёк — начните вход заново";
    }
  }

  revoke(clientId, token) {
    twitchFetch(`${ID_BASE}/revoke`, form({ client_id: clientId, token })).catch(() => {});
  }

  async logout() {
    this.cancelLogin();
    if (!this.auth) return;
    const a = this.auth;
    await this.hideAll(5000); // награды остаются на канале, но скрыты
    this.revoke(a.clientId, a.accessToken);
    this.dropAuth(null);
    this.log("[REWARD] Signed out of Twitch, rewards hidden");
  }

  // ---- награды на Twitch (сколько угодно: у каждой свой ключ key в настройках и свой id на Twitch)
  rewardsPath(query = "") {
    return `/channel_points/custom_rewards?broadcaster_id=${this.auth.userId}${query}`;
  }

  rewardIdOf(key) {
    return this.auth && this.auth.rewardIds ? this.auth.rewardIds[key] || null : null;
  }

  async updateReward(key, patch, options) {
    const data = await this.helix("PATCH", this.rewardsPath(`&id=${this.rewardIdOf(key)}`), patch, options);
    this.rewards.set(key, data.data[0]);
    return data.data[0];
  }

  async ensureReward(r, manageable) {
    const want = { title: r.title, cost: r.cost };
    let reward = manageable.find(x => x.id === this.rewardIdOf(r.key)) || null;
    // награда могла остаться от прошлого входа — ищем свою по названию (но не занятую другой наградой из списка)
    const taken = new Set(Object.entries(this.auth.rewardIds).filter(([k]) => k !== r.key).map(([, id]) => id));
    if (!reward) reward = manageable.find(x => x.title === want.title && !taken.has(x.id)) || null;
    if (!reward) {
      try {
        const data = await this.helix("POST", this.rewardsPath(), {
          ...want, prompt: REWARD_PROMPT, is_enabled: true, background_color: "#9147FF", should_redemptions_skip_request_queue: false,
        });
        reward = data.data[0];
        this.log(`[REWARD] Created reward "${reward.title}" (${reward.cost} points)`);
      } catch (err) {
        if (err.status === 400 && /duplicate|title/i.test(err.message)) {
          throw new Error(`На канале уже есть награда «${want.title}», созданная не ботом: переименуйте её или задайте другое название`);
        }
        throw err;
      }
    }
    if (this.auth.rewardIds[r.key] !== reward.id) {
      this.auth.rewardIds[r.key] = reward.id;
      this.saveAuth();
    }
    this.rewards.set(r.key, reward);
    const patch = {};
    if (reward.title !== want.title) patch.title = want.title;
    if (reward.cost !== want.cost) patch.cost = want.cost;
    if (!reward.is_enabled) patch.is_enabled = true;
    if (reward.should_redemptions_skip_request_queue) patch.should_redemptions_skip_request_queue = false; // иначе баллы не вернуть
    if (Object.keys(patch).length) {
      const updated = await this.updateReward(r.key, patch);
      if (patch.title || patch.cost) this.log(`[REWARD] Reward updated: "${updated.title}", ${updated.cost} points`);
    }
    return this.rewards.get(r.key);
  }

  // Активации, сделанные пока бот не слушал (был выключен, упал, рвалась связь), — вернуть баллы
  async refundMissed(before) {
    for (const r of this.cfg.rewards.filter(x => x.enabled)) {
      const rid = this.rewardIdOf(r.key);
      if (!rid) continue;
      const data = await this.helix("GET", `/channel_points/custom_rewards/redemptions?broadcaster_id=${this.auth.userId}&reward_id=${rid}&status=UNFULFILLED&first=50`);
      const ids = data.data.filter(x => !this.inFlight.has(x.id) && Date.parse(x.redeemed_at) < before).map(x => x.id);
      if (!ids.length) continue;
      await this.helix("PATCH", `/channel_points/custom_rewards/redemptions?broadcaster_id=${this.auth.userId}&reward_id=${rid}&${ids.map(id => `id=${id}`).join("&")}`, { status: "CANCELED" });
      this.log(`[REWARD] "${r.title}": refunded ${ids.length} redemption(s) made while the bot was not listening`);
    }
  }

  // Эдит пошёл — засчитать, нет — вернуть баллы
  async resolve(redemption, ok) {
    try {
      await this.helix("PATCH", `/channel_points/custom_rewards/redemptions?broadcaster_id=${this.auth.userId}&reward_id=${redemption.rewardId}&id=${redemption.id}`,
        { status: ok ? "FULFILLED" : "CANCELED" });
    } catch (err) {
      this.log(`[REWARD] Could not mark the redemption of ${redemption.user} as ${ok ? "fulfilled" : "refunded"}: ${describe(err)}`);
    } finally {
      this.inFlight.delete(redemption.id);
    }
  }

  // ---- синхронизация: привести награды и подписку к настройкам
  scheduleSync() {
    if (this.stopped) return Promise.resolve();
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        this.lastSyncAt = Date.now();
        try {
          await this.sync();
          this.error = null;
        } catch (err) {
          const msg = describe(err);
          if (msg !== this.error) this.log(`[REWARD] ${msg}`);
          this.error = msg;
        }
      } while (this.syncAgain && !this.stopped);
      this.syncing = null;
    })();
    return this.syncing;
  }

  async sync() {
    if (!this.auth || !this.cfg) { this.closeSocket(); return; }
    if (!this.auth.rewardIds) this.auth.rewardIds = {};
    const { data: manageable } = await this.helix("GET", this.rewardsPath("&only_manageable_rewards=true"));
    for (const x of manageable) {
      const key = Object.keys(this.auth.rewardIds).find(k => this.auth.rewardIds[k] === x.id);
      if (key) this.rewards.set(key, x);
    }
    // награды, которые убрали из списка, — прячем (не удаляем: с тем же названием бот подхватит её снова)
    for (const [key, id] of Object.entries(this.auth.rewardIds)) {
      if (this.cfg.rewards.some(r => r.key === key)) continue;
      const known = manageable.find(x => x.id === id);
      if (known && known.is_enabled) {
        await this.helix("PATCH", this.rewardsPath(`&id=${id}`), { is_enabled: false }).catch(err => { if (err.status !== 404) throw err; });
        this.log(`[REWARD] "${known.title}" hidden (removed from the list)`);
      }
      delete this.auth.rewardIds[key];
      this.rewards.delete(key);
      this.saveAuth();
    }
    const paused = !this.isAvailable();
    let active = 0;
    for (const r of this.cfg.rewards) {
      try {
        if (!r.enabled) {
          const known = this.rewards.get(r.key);
          if (known && known.is_enabled) {
            await this.updateReward(r.key, { is_enabled: false });
            this.log(`[REWARD] "${r.title}" hidden (turned off in settings)`);
          }
          this.rewardErrors.delete(r.key);
          continue;
        }
        const reward = await this.ensureReward(r, manageable);
        if (reward.is_paused !== paused) {
          await this.updateReward(r.key, { is_paused: paused });
          this.log(paused ? `[REWARD] "${r.title}" paused: the edit can't start now (OBS not connected?)` : `[REWARD] "${r.title}" is active`);
        }
        this.rewardErrors.delete(r.key);
        active++;
      } catch (err) {
        const msg = describe(err);
        if (this.rewardErrors.get(r.key) !== msg) this.log(`[REWARD] "${r.title}": ${msg}`);
        this.rewardErrors.set(r.key, msg);
      }
    }
    this.paused = active ? paused : null;
    this.pendingPause = 0;
    if (!active) { this.closeSocket(); return; }
    if (!this.ws) this.openSocket(EVENTSUB_URL);
  }

  check() {
    if (this.stopped || !this.auth || !this.cfg || !this.cfg.rewards.some(r => r.enabled)) return;
    if ((this.error || this.rewardErrors.size) && Date.now() - this.lastSyncAt > RETRY_SYNC_MS) { this.scheduleSync(); return; }
    if (this.paused === null) return;
    const paused = !this.isAvailable();
    if (paused === this.paused) { this.pendingPause = 0; return; }
    if (paused && ++this.pendingPause < 2) return; // короткий обрыв связи с OBS — награды не дёргаем
    this.scheduleSync();
  }

  // ---- EventSub WebSocket
  openSocket(url, { reconnectFrom = null } = {}) {
    if (!reconnectFrom) this.closeSocket();
    const ws = new WebSocket(url);
    this.ws = ws;
    let keepaliveMs = 30000;
    const watchdog = () => {
      clearTimeout(ws.watchdog);
      ws.watchdog = setTimeout(() => ws.terminate(), keepaliveMs + 10000); // ни события, ни keepalive — связь потеряна
    };
    ws.on("open", watchdog);
    ws.on("message", async (raw) => {
      watchdog();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const meta = msg.metadata || {};
      const type = meta.message_type;
      if (meta.message_id) {
        if (this.seen.includes(meta.message_id)) return;
        this.seen.push(meta.message_id);
        if (this.seen.length > 200) this.seen.shift();
      }
      if (type === "session_welcome") {
        const session = msg.payload.session;
        keepaliveMs = (session.keepalive_timeout_seconds || 30) * 1000;
        watchdog();
        this.sessionId = session.id;
        this.wsFailures = 0;
        if (reconnectFrom) { // подписки переехали вместе с сессией, старое соединение больше не нужно
          reconnectFrom.intentional = true;
          reconnectFrom.close();
          return;
        }
        try {
          const subscribedAt = Date.now();
          await this.helix("POST", "/eventsub/subscriptions", {
            type: REDEMPTION_EVENT, version: "1",
            condition: { broadcaster_user_id: this.auth.userId }, // все награды канала: чужие пропускаем ниже
            transport: { method: "websocket", session_id: session.id },
          }).catch(err => { if (err.status !== 409) throw err; });
          this.log(`[REWARD] Listening for redemptions: ${this.cfg.rewards.filter(r => r.enabled).map(r => `"${r.title}"`).join(", ")}`);
          await this.refundMissed(subscribedAt);
        } catch (err) {
          this.error = `Не удалось подписаться на награды: ${describe(err)}`;
          this.log(`[REWARD] ${this.error}`);
          ws.close(); // переподключимся по закрытию
        }
      } else if (type === "session_reconnect") {
        this.openSocket(msg.payload.session.reconnect_url, { reconnectFrom: ws });
      } else if (type === "notification" && meta.subscription_type === REDEMPTION_EVENT) {
        const e = msg.payload.event;
        if (!this.auth || !this.auth.rewardIds) return;
        const key = Object.keys(this.auth.rewardIds).find(k => this.auth.rewardIds[k] === e.reward.id);
        const r = key && this.cfg.rewards.find(x => x.key === key && x.enabled);
        if (!r) return; // чужая награда стримера — не наша забота, не трогаем
        this.inFlight.add(e.id);
        this.emit("redemption", { id: e.id, rewardId: e.reward.id, key, title: r.title, user: e.user_name || e.user_login });
      } else if (type === "revocation") {
        const status = msg.payload.subscription && msg.payload.subscription.status;
        if (status === "authorization_revoked" || status === "user_removed") {
          this.dropAuth("Twitch отозвал доступ бота к наградам — войдите заново");
        } else {
          this.log(`[REWARD] Subscription revoked (${status}), resubscribing`);
          ws.close();
        }
      }
    });
    ws.on("error", (err) => {
      if (!ws.intentional) this.log(`[REWARD] EventSub error: ${err.message}`);
    });
    ws.on("close", (code) => {
      clearTimeout(ws.watchdog);
      if (this.ws !== ws) return; // заменено новым соединением
      this.ws = null;
      this.sessionId = null;
      if (ws.intentional || this.stopped) return;
      const delay = Math.min(60000, 5000 * 2 ** this.wsFailures++);
      this.log(`[REWARD] EventSub disconnected (${code}), reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => { if (!this.ws) this.scheduleSync(); }, delay);
    });
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.sessionId = null;
    if (!ws) return;
    ws.intentional = true;
    clearTimeout(ws.watchdog);
    try { ws.close(); } catch {}
  }

  // ---- для панели
  state() {
    const now = Date.now();
    return {
      signedIn: Boolean(this.auth),
      login: this.auth ? this.auth.login : null,
      pending: this.login ? { code: this.login.userCode, uri: this.login.uri, expiresIn: Math.max(0, Math.round((this.login.expiresAt - now) / 1000)) } : null,
      rewards: (this.cfg ? this.cfg.rewards : []).map(r => {
        const tw = this.auth ? this.rewards.get(r.key) : null;
        return {
          key: r.key, title: r.title, enabled: r.enabled, error: this.rewardErrors.get(r.key) || null,
          twitch: tw ? { title: tw.title, cost: tw.cost, enabled: tw.is_enabled, paused: tw.is_paused } : null,
        };
      }),
      listening: Boolean(this.sessionId),
      error: this.error,
    };
  }

  // Бот выключается — награду прячем, чтобы зрители не тратили баллы впустую
  async shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    this.cancelLogin();
    this.closeSocket();
    if (await this.hideAll(3000)) this.log("[REWARD] Rewards hidden while the bot is off");
  }

  // Спрятать все наши видимые награды (бот выключается / выход из Twitch). Возвращает, было ли что прятать
  async hideAll(timeout) {
    if (!this.auth || !this.auth.rewardIds) return false;
    const visible = [...this.rewards.entries()].filter(([key, r]) => r.is_enabled && this.auth.rewardIds[key]);
    await Promise.all(visible.map(([key]) => this.updateReward(key, { is_enabled: false }, { timeout }).catch(() => {})));
    return visible.length > 0;
  }
}

module.exports = { RewardManager };
