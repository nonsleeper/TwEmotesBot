// Клиент встроенного в OBS (28+) сервера WebSocket, протокол v5.
// Без зависимостей кроме ws: авторизация, запросы, пакеты запросов (по одному на кадр эдита), события
// (InputVolumeMeters — уровни звука для поиска битов) и переподключение.
const WebSocket = require("ws");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7, RequestBatch: 8, RequestBatchResponse: 9 };
// Scenes | SceneItems | InputVolumeMeters (high-volume, ~20 раз в секунду)
const EVENT_SUBSCRIPTIONS = (1 << 2) | (1 << 7) | (1 << 16);
const REQUEST_TIMEOUT_MS = 5000;

const sha256b64 = (text) => crypto.createHash("sha256").update(text).digest("base64");

class ObsClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.options = null;
    this.identified = false;
    this.error = null;
    this.pending = new Map();
    this.nextId = 1;
    this.retryTimer = null;
    this.closedByUs = false;
  }

  status() {
    return { configured: Boolean(this.options), connected: this.identified, error: this.error };
  }

  // host/port/password из настроек; повторный вызов с теми же значениями ничего не делает
  configure({ host = "127.0.0.1", port = 4455, password = "" } = {}) {
    const next = { host: host || "127.0.0.1", port: Number(port) || 4455, password: password || "" };
    if (this.options && JSON.stringify(this.options) === JSON.stringify(next)) return;
    this.options = next;
    this.disconnect();
    this.closedByUs = false;
    this.connect();
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.options) return;
    const { host, port } = this.options;
    const ws = new WebSocket(`ws://${host}:${port}`, "obswebsocket.json", { handshakeTimeout: 4000 });
    this.ws = ws;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.onMessage(msg);
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      const wasReady = this.identified;
      this.identified = false;
      this.ws = null;
      for (const [, p] of this.pending) p.reject(new Error("Соединение с OBS закрыто"));
      this.pending.clear();
      if (code === 4009) this.error = "OBS: неверный пароль WebSocket";
      else if (code === 4010) this.error = "OBS: неподдерживаемая версия протокола";
      else if (!this.error || wasReady) this.error = wasReady ? "OBS закрыл соединение" : this.error || "OBS недоступен";
      if (wasReady) this.emit("disconnected", this.error);
      else if (this.error !== this.lastReported) this.emit("failed", this.error); // в лог — только когда причина сменилась
      this.lastReported = this.error;
      if (!this.closedByUs) {
        // неверный пароль сам не исправится — пробуем реже
        this.retryTimer = setTimeout(() => this.connect(), code === 4009 ? 30000 : 5000);
      }
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      const http = /Unexpected server response: (\d+)/.exec(err.message);
      this.error = err.code === "ECONNREFUSED"
        ? "OBS не отвечает: он не запущен или сервер WebSocket выключен (Сервис → Настройки сервера WebSocket)"
        : http
          // ответил кто-то, но не сервер WebSocket OBS: чужая программа на этом порту, VPN/прокси на пути к адресу
          ? `По адресу ${this.options.host}:${this.options.port} ответил не OBS (HTTP ${http[1]}). Проверьте адрес и порт; если OBS на этом же компьютере — укажите 127.0.0.1`
          : `OBS: ${err.message}`;
    });
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    if (ws) { try { ws.close(); } catch {} }
  }

  onMessage({ op, d }) {
    if (op === OP.Hello) {
      const identify = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
      if (d.authentication) {
        const secret = sha256b64(this.options.password + d.authentication.salt);
        identify.authentication = sha256b64(secret + d.authentication.challenge);
      }
      this.send(OP.Identify, identify);
    } else if (op === OP.Identified) {
      this.identified = true;
      this.error = null;
      this.lastReported = null;
      this.emit("ready");
    } else if (op === OP.Event) {
      if (d.eventType === "InputVolumeMeters") this.emit("meters", d.eventData.inputs || []);
      else this.emit("event", d.eventType, d.eventData || {});
    } else if (op === OP.RequestResponse || op === OP.RequestBatchResponse) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (op === OP.RequestBatchResponse) {
        p.resolve(d.results || []);
      } else if (d.requestStatus && d.requestStatus.result) {
        p.resolve(d.responseData || {});
      } else {
        const st = d.requestStatus || {};
        p.reject(Object.assign(new Error(st.comment || `OBS: ошибка запроса ${d.requestType} (${st.code})`), { code: st.code }));
      }
    }
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  wait(requestId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("OBS не ответил вовремя"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  request(requestType, requestData = {}) {
    if (!this.identified) return Promise.reject(new Error(this.error || "Нет связи с OBS"));
    const requestId = `r${this.nextId++}`;
    const promise = this.wait(requestId);
    this.send(OP.Request, { requestType, requestId, requestData });
    return promise;
  }

  // Несколько запросов одним сообщением; ошибки отдельных запросов не прерывают остальные
  batch(requests) {
    if (!this.identified) return Promise.reject(new Error(this.error || "Нет связи с OBS"));
    const requestId = `b${this.nextId++}`;
    const promise = this.wait(requestId);
    this.send(OP.RequestBatch, {
      requestId,
      haltOnFailure: false,
      executionType: 0, // SerialRealtime
      requests: requests.map((r, i) => ({ requestType: r.requestType, requestId: String(i), requestData: r.requestData || {} })),
    });
    return promise;
  }
}

module.exports = { ObsClient };
