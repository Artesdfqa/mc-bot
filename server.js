const express = require("express");
const bedrock = require("bedrock-protocol");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const HOST = "6-10.phoenix-pe.net";
const MC_PORT = 19135;

// Версии от новой к старой
const VERSIONS = [
  "1.21.93", "1.21.80", "1.21.70", "1.21.60", "1.21.50",
  "1.21.42", "1.21.30", "1.21.2",  "1.21.0",
  "1.20.80", "1.20.71", "1.20.61", "1.20.50", "1.20.40",
  "1.20.30", "1.20.10", "1.20.0",
  "1.19.80", "1.19.70", "1.19.63", "1.19.60", "1.19.50",
  "1.19.40", "1.19.30", "1.19.21", "1.19.10", "1.19.1",
];

// Хранилище ботов
const bots = {};

// ─── GUI формы ────────────────────────────────────────────────────────────────
function setupFormHandler(client, entry, username, password) {
  client.on("modal_form_request", (packet) => {
    const formId = packet.id;
    let formData;
    try { formData = JSON.parse(packet.data); } catch (_) { return; }

    const type      = formData.type;
    const title     = formData.title || "";
    const content   = formData.content || "";
    const contentStr = typeof content === "string" ? content : "";
    const fields    = Array.isArray(content) ? content : [];
    const all       = (title + " " + contentStr + " " + fields.map(f => f.text || "").join(" ")).toLowerCase();

    entry.addLog(`Форма: "${title}" (${type})`, "form");

    let intent = "unknown";
    if (all.includes("промокод") || all.includes("promo")) intent = "promo";
    else if (all.includes("создайте пароль") || all.includes("придумайте") || all.includes("регистрац") || all.includes("register") || all.includes("новый пароль")) intent = "register";
    else if (all.includes("пароль") || all.includes("password") || all.includes("авториз") || all.includes("login") || all.includes("войти")) intent = "auth";

    if (type === "custom_form") {
      const responses = fields.map((field, i) => {
        const label = (field.text || field.placeholder || "").toLowerCase();
        if (field.type === "toggle")      return false;
        if (field.type === "slider")      return field.min ?? 0;
        if (field.type === "step_slider") return 0;
        if (field.type === "dropdown")    return 0;
        if (field.type !== "input")       return null;
        if (intent === "promo") return "";
        if (label.includes("повтор") || label.includes("подтвер") || label.includes("confirm") || label.includes("repeat")) return password;
        if (label.includes("пароль") || label.includes("pass"))   return password;
        if (label.includes("ник") || label.includes("nick") || label.includes("логин") || label.includes("login") || label.includes("name")) return username;
        if (intent === "auth" || intent === "register") return password;
        if (fields.filter(f => f.type === "input").length === 1)  return password;
        return "";
      });
      entry.addLog(`  Ответ: ${JSON.stringify(responses)}`, "form");
      try { client.queue("modal_form_response", { id: formId, canceled: false, data: JSON.stringify(responses) }); } catch (_) {}

    } else if (type === "modal") {
      try { client.queue("modal_form_response", { id: formId, canceled: false, data: "true" }); } catch (_) {}

    } else if (type === "form") {
      const buttons = formData.buttons || [];
      const priorities = ["войти","login","sign in","авториз","зайти","вход","регистр","register"];
      let chosen = 0;
      outer: for (const kw of priorities)
        for (let i = 0; i < buttons.length; i++)
          if ((buttons[i].text || "").toLowerCase().includes(kw)) { chosen = i; break outer; }
      entry.addLog(`  Кнопка [${chosen}]: "${buttons[chosen]?.text}"`, "form");
      try { client.queue("modal_form_response", { id: formId, canceled: false, data: String(chosen) }); } catch (_) {}
    }
  });
}

// ─── Чат ──────────────────────────────────────────────────────────────────────
function setupChatHandler(client, entry, password) {
  client.on("text", (packet) => {
    const msg = packet.message || (packet.parameters ? packet.parameters.join("") : "") || "";
    if (!msg) return;
    entry.addLog(msg, "chat");
    const lower = msg.toLowerCase();
    if (lower.includes("успешно") || lower.includes("авторизован") || lower.includes("добро пожаловать") || lower.includes("welcome"))
      entry.status = "authorized";
    if (lower.includes("неверный пароль") || lower.includes("wrong password"))
      entry.addLog("⚠️ Неверный пароль!", "warn");
  });
}

// ─── Движение бота ────────────────────────────────────────────────────────────
function startMovement(client, entry, username) {
  // Направления: [forward, backward, left, right, yaw]
  const MOVES = [
    { forward: true,  backward: false, left: false, right: false, yaw: 0   },
    { forward: true,  backward: false, left: false, right: false, yaw: 90  },
    { forward: true,  backward: false, left: false, right: false, yaw: 180 },
    { forward: true,  backward: false, left: false, right: false, yaw: 270 },
  ];

  let pos       = { x: 0, y: 64, z: 0 };
  let lastPos   = { x: 0, y: 64, z: 0 };
  let moveDir   = 0;          // текущий индекс в MOVES
  let stuckCount = 0;
  let moveInterval = null;
  let tickCount = 0;

  // Следим за позицией
  client.on("move_player", (packet) => {
    if (packet.runtime_id === client.entityId) {
      pos = { x: packet.position.x, y: packet.position.y, z: packet.position.z };
    }
  });

  // Тик каждые 500ms
  moveInterval = setInterval(() => {
    if (!entry.client) { clearInterval(moveInterval); return; }

    tickCount++;

    // Каждые 8 тиков (4 сек) — проверяем застрял ли бот
    if (tickCount % 8 === 0) {
      const dx = Math.abs(pos.x - lastPos.x);
      const dz = Math.abs(pos.z - lastPos.z);
      if (dx < 0.3 && dz < 0.3) {
        stuckCount++;
        entry.addLog(`🔄 Застрял (${stuckCount}x) — меняю направление`, "warn");
        moveDir = (moveDir + 1) % MOVES.length;
        // Прыжок чтобы выбраться
        sendInput(client, username, pos, MOVES[moveDir], true);
      } else {
        stuckCount = 0;
      }
      lastPos = { ...pos };
    }

    // Каждые 40 тиков (20 сек) — меняем направление случайно
    if (tickCount % 40 === 0) {
      moveDir = Math.floor(Math.random() * MOVES.length);
      entry.addLog(`🧭 Новое направление: ${["Север","Восток","Юг","Запад"][moveDir]}`, "info");
    }

    sendInput(client, username, pos, MOVES[moveDir], false);
  }, 500);

  entry.moveInterval = moveInterval;
  entry.addLog("🚶 Движение запущено", "success");
}

function sendInput(client, username, pos, move, jump) {
  try {
    const yawRad = (move.yaw * Math.PI) / 180;
    client.queue("player_action", {
      runtime_entity_id: client.entityId || BigInt(1),
      action: jump ? "jump" : "start_sprint",
      block_position: { x: 0, y: 0, z: 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0,
    });
    client.queue("move_player", {
      runtime_id: client.entityId || BigInt(1),
      position: { x: pos.x, y: pos.y, z: pos.z },
      pitch: 0,
      yaw: move.yaw,
      head_yaw: move.yaw,
      mode: 0,
      on_ground: true,
      riding_runtime_id: BigInt(0),
      tick: BigInt(0),
    });
  } catch (_) {}
}

function stopMovement(entry) {
  if (entry.moveInterval) {
    clearInterval(entry.moveInterval);
    entry.moveInterval = null;
  }
}

// ─── Перебор версий + подключение ─────────────────────────────────────────────
function connectWithVersionFallback(username, password, entry, versions, idx = 0) {
  if (idx >= versions.length) {
    entry.addLog("❌ Не удалось подобрать версию протокола", "error");
    entry.status = "error";
    delete bots[username];
    return;
  }

  const version = versions[idx];
  entry.addLog(`Пробуем v${version}...`, "info");

  let client;
  try {
    client = bedrock.createClient({ host: HOST, port: MC_PORT, username, offline: true, version });
  } catch (e) {
    return connectWithVersionFallback(username, password, entry, versions, idx + 1);
  }

  entry.client = client;

  const timeout = setTimeout(() => {
    try { client.disconnect(); } catch (_) {}
    entry.addLog(`v${version}: таймаут`, "warn");
    entry.client = null;
    connectWithVersionFallback(username, password, entry, versions, idx + 1);
  }, 8000);

  client.on("spawn", () => {
    clearTimeout(timeout);
    entry.status = "online";
    entry.addLog(`✅ Зашёл на сервер! Версия: ${version}`, "success");

    // Авторизация через чат
    setTimeout(() => {
      try {
        client.queue("text", {
          type: "chat", needs_translation: false,
          source_name: username, xuid: "", platform_chat_id: "",
          message: `/login ${password}`,
        });
        entry.addLog("Отправил /login", "info");
      } catch (_) {}
    }, 2500);

    // Запуск движения через 5 сек (после авторизации)
    setTimeout(() => {
      if (entry.status !== "disconnected" && entry.status !== "error") {
        startMovement(client, entry, username);
      }
    }, 5000);
  });

  client.on("disconnect", (reason) => {
    clearTimeout(timeout);
    stopMovement(entry);
    const msg = reason?.message || reason?.reason || JSON.stringify(reason) || "";
    const isVersionError =
      msg.includes("Packet processing error") || msg.includes("outdated") ||
      msg.includes("update") || msg.includes("version") ||
      msg.includes("protocol") || msg.includes("ff8d");

    if (isVersionError) {
      entry.addLog(`v${version}: несовместима`, "warn");
      entry.client = null;
      connectWithVersionFallback(username, password, entry, versions, idx + 1);
    } else {
      entry.addLog(`❌ Отключён: ${msg}`, "error");
      entry.status = "disconnected";
      entry.client = null;
    }
  });

  client.on("error", (err) => {
    clearTimeout(timeout);
    stopMovement(entry);
    entry.addLog(`v${version}: ${err.message}`, "warn");
    entry.client = null;
    connectWithVersionFallback(username, password, entry, versions, idx + 1);
  });

  setupFormHandler(client, entry, username, password);
  setupChatHandler(client, entry, password);
}

// ─── API: запустить бота ──────────────────────────────────────────────────────
app.post("/api/start", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password)
    return res.status(400).json({ error: "Укажи ник и пароль" });
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: "Ник: 3-16 символов, только буквы/цифры/_" });
  if (password.length < 4)
    return res.status(400).json({ error: "Пароль слишком короткий (мин. 4 символа)" });
  if (bots[username])
    return res.status(409).json({ error: `Бот "${username}" уже запущен` });

  const entry = {
    client: null, logs: [], status: "connecting",
    password, username, moveInterval: null,
    startedAt: new Date().toISOString(),
  };
  entry.addLog = function(msg, type = "info") {
    this.logs.push({ msg, type, ts: new Date().toLocaleTimeString("ru") });
    if (this.logs.length > 300) this.logs.shift();
    console.log(`[${username}] ${msg}`);
  };

  bots[username] = entry;
  entry.addLog(`Подключение к ${HOST}:${MC_PORT}...`);
  connectWithVersionFallback(username, password, entry, VERSIONS);

  res.json({ success: true, message: `Бот "${username}" запускается...` });
});

// ─── API: остановить бота ─────────────────────────────────────────────────────
app.post("/api/stop", (req, res) => {
  const { username } = req.body || {};
  const entry = bots[username];
  if (!entry) return res.status(404).json({ error: "Бот не найден" });
  stopMovement(entry);
  try { if (entry.client) entry.client.disconnect(); } catch (_) {}
  delete bots[username];
  res.json({ success: true, message: `Бот "${username}" остановлен` });
});

// ─── API: логи ────────────────────────────────────────────────────────────────
app.get("/api/logs/:username", (req, res) => {
  const entry = bots[req.params.username];
  if (!entry) return res.status(404).json({ error: "Бот не найден" });
  res.json({ logs: entry.logs, status: entry.status });
});

// ─── API: список ботов ────────────────────────────────────────────────────────
app.get("/api/bots", (req, res) => {
  res.json({
    bots: Object.entries(bots).map(([username, e]) => ({
      username, status: e.status, startedAt: e.startedAt,
      moving: !!e.moveInterval,
    }))
  });
});

app.listen(PORT, () => console.log(`[SERVER] Запущен на порту ${PORT}`));
