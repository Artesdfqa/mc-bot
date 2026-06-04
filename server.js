const express = require("express");
const path = require("path");
const bedrock = require("bedrock-protocol");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const HOST = "6-10.phoenix-pe.net";
const MC_PORT = 19135;

// Хранилище активных ботов: ник -> { client, logs, status }
const bots = {};

// ─── Запустить бота ────────────────────────────────────────────────────────
app.post("/api/start", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Укажи ник и пароль" });
  }
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: "Ник: 3-16 символов, только буквы/цифры/_" });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Пароль слишком короткий (мин. 4 символа)" });
  }
  if (bots[username]) {
    return res.status(409).json({ error: `Бот "${username}" уже запущен` });
  }

  const entry = {
    client: null,
    logs: [],
    status: "connecting",
    password,
    username,
    startedAt: new Date().toISOString(),
  };
  bots[username] = entry;

  function addLog(msg, type = "info") {
    const line = { msg, type, ts: new Date().toLocaleTimeString("ru") };
    entry.logs.push(line);
    if (entry.logs.length > 200) entry.logs.shift();
    console.log(`[${username}] ${msg}`);
  }

  addLog(`Подключение к ${HOST}:${MC_PORT}...`);

  let client;
  try {
    client = bedrock.createClient({
      host: HOST,
      port: MC_PORT,
      username,
      offline: true,
      version: "1.20.0",
    });
  } catch (e) {
    addLog(`Ошибка создания клиента: ${e.message}`, "error");
    delete bots[username];
    return res.status(500).json({ error: e.message });
  }

  entry.client = client;

  client.on("spawn", () => {
    entry.status = "online";
    addLog(`✅ Бот "${username}" зашёл на сервер!`, "success");

    // Пробуем /login через чат
    setTimeout(() => {
      try {
        client.queue("text", {
          type: "chat",
          needs_translation: false,
          source_name: username,
          xuid: "",
          platform_chat_id: "",
          message: `/login ${password}`,
        });
        addLog("Отправил /login через чат", "info");
      } catch (e) {}
    }, 2500);
  });

  // ── GUI Формы ──────────────────────────────────────────────────────────────
  client.on("modal_form_request", (packet) => {
    const formId = packet.id;
    let formData;
    try { formData = JSON.parse(packet.data); }
    catch (e) { addLog("Не удалось разобрать форму", "warn"); return; }

    const type = formData.type;
    const title = formData.title || "";
    const content = formData.content || "";
    const contentStr = typeof content === "string" ? content : "";
    const fields = Array.isArray(content) ? content : [];
    const all = (title + " " + contentStr + " " + fields.map(f => f.text || "").join(" ")).toLowerCase();

    addLog(`Форма: "${title}" (${type})`, "form");

    let intent = "unknown";
    if (all.includes("промокод") || all.includes("promo")) intent = "promo";
    else if (all.includes("создайте пароль") || all.includes("придумайте") || all.includes("регистрац") || all.includes("register") || all.includes("новый пароль")) intent = "register";
    else if (all.includes("пароль") || all.includes("password") || all.includes("авториз") || all.includes("login") || all.includes("войти")) intent = "auth";

    addLog(`  Тип формы: ${intent}`, "form");

    if (type === "custom_form") {
      const responses = fields.map((field, i) => {
        const label = (field.text || field.placeholder || "").toLowerCase();
        if (field.type !== "input") {
          if (field.type === "toggle") return false;
          if (field.type === "slider") return field.min ?? 0;
          if (field.type === "step_slider") return 0;
          if (field.type === "dropdown") return 0;
          return null;
        }
        if (intent === "promo") return "";
        if (label.includes("повтор") || label.includes("подтвер") || label.includes("confirm") || label.includes("repeat")) {
          addLog(`  [${i}] подтверждение пароля`, "form"); return password;
        }
        if (label.includes("пароль") || label.includes("pass") || label.includes("password")) {
          addLog(`  [${i}] пароль`, "form"); return password;
        }
        if (label.includes("ник") || label.includes("nick") || label.includes("логин") || label.includes("login") || label.includes("name")) {
          addLog(`  [${i}] ник`, "form"); return username;
        }
        if (intent === "auth" || intent === "register") {
          addLog(`  [${i}] авторизация → пароль`, "form"); return password;
        }
        if (fields.filter(f => f.type === "input").length === 1) {
          addLog(`  [${i}] единственное поле → пароль`, "form"); return password;
        }
        return "";
      });

      addLog(`  Ответ: ${JSON.stringify(responses)}`, "form");
      try {
        client.queue("modal_form_response", { id: formId, canceled: false, data: JSON.stringify(responses) });
      } catch (e) {}

    } else if (type === "modal") {
      addLog(`  Modal → ОК`, "form");
      try { client.queue("modal_form_response", { id: formId, canceled: false, data: "true" }); } catch (e) {}

    } else if (type === "form") {
      const buttons = formData.buttons || [];
      addLog(`  Кнопки: ${buttons.map((b, i) => `[${i}]"${b.text}"`).join(", ")}`, "form");
      const priorities = ["войти", "login", "sign in", "авториз", "зайти", "вход", "регистр", "register"];
      let chosen = 0;
      outer: for (const kw of priorities) {
        for (let i = 0; i < buttons.length; i++) {
          if ((buttons[i].text || "").toLowerCase().includes(kw)) { chosen = i; break outer; }
        }
      }
      addLog(`  → кнопка [${chosen}]: "${buttons[chosen]?.text}"`, "form");
      try { client.queue("modal_form_response", { id: formId, canceled: false, data: String(chosen) }); } catch (e) {}
    }
  });

  // ── Чат ───────────────────────────────────────────────────────────────────
  client.on("text", (packet) => {
    const msg = packet.message || (packet.parameters ? packet.parameters.join("") : "") || "";
    if (!msg) return;
    addLog(msg, "chat");
    const lower = msg.toLowerCase();
    if (lower.includes("успешно") || lower.includes("авторизован") || lower.includes("добро пожаловать") || lower.includes("welcome")) {
      entry.status = "authorized";
      addLog("✅ Авторизация успешна!", "success");
    }
    if (lower.includes("неверный пароль") || lower.includes("wrong password")) {
      addLog("⚠️ Неверный пароль!", "warn");
    }
  });

  client.on("disconnect", (reason) => {
    const msg = reason?.message || reason?.reason || JSON.stringify(reason);
    addLog(`❌ Отключён: ${msg}`, "error");
    entry.status = "disconnected";
    entry.client = null;
  });

  client.on("error", (err) => {
    addLog(`Ошибка: ${err.message}`, "error");
    entry.status = "error";
    entry.client = null;
  });

  res.json({ success: true, message: `Бот "${username}" запускается...` });
});

// ─── Остановить бота ───────────────────────────────────────────────────────
app.post("/api/stop", (req, res) => {
  const { username } = req.body || {};
  const entry = bots[username];
  if (!entry) return res.status(404).json({ error: "Бот не найден" });

  try { if (entry.client) entry.client.disconnect(); } catch (e) {}
  delete bots[username];
  res.json({ success: true, message: `Бот "${username}" остановлен` });
});

// ─── Логи бота ────────────────────────────────────────────────────────────
app.get("/api/logs/:username", (req, res) => {
  const entry = bots[req.params.username];
  if (!entry) return res.status(404).json({ error: "Бот не найден" });
  res.json({ logs: entry.logs, status: entry.status });
});

// ─── Список всех ботов ─────────────────────────────────────────────────────
app.get("/api/bots", (req, res) => {
  const list = Object.entries(bots).map(([username, e]) => ({
    username,
    status: e.status,
    startedAt: e.startedAt,
  }));
  res.json({ bots: list });
});

app.listen(PORT, () => {
  console.log(`[SERVER] MC Bot сервер запущен на порту ${PORT}`);
});
