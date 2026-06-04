const bedrock = require("bedrock-protocol");

const args = process.argv.slice(2);
const username = args[0];
const password = args[1];

if (!username || !password) {
  console.error("Использование: node bot.js <ник> <пароль>");
  process.exit(1);
}

const HOST = "6-10.phoenix-pe.net";
const PORT = 19135;

console.log(`[BOT] Подключение как "${username}" к ${HOST}:${PORT}...`);

const client = bedrock.createClient({
  host: HOST,
  port: PORT,
  username: username,
  offline: true,
  version: "1.20.0",
});

// Состояние авторизации
const authState = {
  attempts: 0,
  authorized: false,
  lastFormTitle: "",
  lastFormContent: "",
};

client.on("spawn", () => {
  console.log(`[BOT] ✅ Бот "${username}" зашёл на сервер!`);
});

// Определяем что за форма пришла
function detectFormIntent(title, contentStr, fields) {
  const all = (title + " " + contentStr + " " + fields.map(f => f.text || "").join(" ")).toLowerCase();

  if (all.includes("промокод") || all.includes("promo") || (all.includes("code") && !all.includes("pass"))) {
    return "promo";
  }
  if (
    all.includes("создайте пароль") || all.includes("придумайте пароль") ||
    all.includes("create password") || all.includes("set password") ||
    all.includes("новый пароль") || all.includes("new password") ||
    all.includes("регистрац") || all.includes("register")
  ) {
    return "register";
  }
  if (
    all.includes("введите пароль") || all.includes("enter password") ||
    all.includes("авториз") || all.includes("login") || all.includes("войти") ||
    all.includes("вход") || all.includes("пароль") || all.includes("password")
  ) {
    return "auth";
  }
  return "unknown";
}

client.on("modal_form_request", (packet) => {
  const formId = packet.id;
  let formData;

  try {
    formData = JSON.parse(packet.data);
  } catch (e) {
    console.warn("[FORM] Не удалось разобрать форму:", e.message);
    return;
  }

  const type = formData.type;
  const title = formData.title || "";
  const content = formData.content || "";
  const contentStr = typeof content === "string" ? content : "";
  const fields = Array.isArray(content) ? content : [];

  const intent = detectFormIntent(title, contentStr, fields);

  console.log(`\n[FORM] ══════════════════════════════`);
  console.log(`[FORM] Тип: ${type} | Intent: ${intent}`);
  console.log(`[FORM] Заголовок: "${title}"`);
  if (contentStr) console.log(`[FORM] Текст: "${contentStr.substring(0, 120)}"`);
  authState.attempts++;
  console.log(`[FORM] Попытка #${authState.attempts}`);

  // ─── custom_form ──────────────────────────────────────────────────────────
  if (type === "custom_form") {
    const responses = fields.map((field, i) => {
      const label = (field.text || field.placeholder || "").toLowerCase();
      console.log(`[FORM]   [${i}] type="${field.type}" label="${field.text || ""}"`);

      if (field.type === "input") {
        // Промокод — пропускаем
        if (intent === "promo") {
          console.log(`[FORM]   → промокод пропускаем`);
          return "";
        }
        // Подтверждение пароля
        if (label.includes("повтор") || label.includes("подтвер") || label.includes("confirm") || label.includes("repeat")) {
          console.log(`[FORM]   → подтверждение пароля`);
          return password;
        }
        // Пароль
        if (
          label.includes("пароль") || label.includes("pass") ||
          label.includes("password") || intent === "auth" || intent === "register"
        ) {
          console.log(`[FORM]   → вводим пароль: ${password}`);
          return password;
        }
        // Ник / логин
        if (label.includes("ник") || label.includes("nick") || label.includes("логин") || label.includes("login") || label.includes("name")) {
          console.log(`[FORM]   → вводим ник: ${username}`);
          return username;
        }
        // Если поле одно и непонятное — это скорее всего пароль
        if (fields.filter(f => f.type === "input").length === 1) {
          console.log(`[FORM]   → единственное поле — вводим пароль`);
          return password;
        }
        return "";
      }

      if (field.type === "toggle")      return false;
      if (field.type === "slider")      return field.min ?? 0;
      if (field.type === "step_slider") return 0;
      if (field.type === "dropdown")    return 0;
      return null;
    });

    console.log(`[FORM] Отправляем:`, responses);
    client.queue("modal_form_response", {
      id: formId,
      canceled: false,
      data: JSON.stringify(responses),
    });

  // ─── modal ────────────────────────────────────────────────────────────────
  } else if (type === "modal") {
    console.log(`[FORM] → нажимаем ОК`);
    client.queue("modal_form_response", {
      id: formId,
      canceled: false,
      data: "true",
    });

  // ─── form (кнопки) ────────────────────────────────────────────────────────
  } else if (type === "form") {
    const buttons = formData.buttons || [];
    console.log(`[FORM] Кнопки: ${buttons.map((b, i) => `[${i}]"${b.text}"`).join(", ")}`);

    const priorities = ["войти", "login", "sign in", "авториз", "зайти", "вход", "регистр", "register", "создать", "новый"];
    let chosen = 0;
    outer: for (const kw of priorities) {
      for (let i = 0; i < buttons.length; i++) {
        if ((buttons[i].text || "").toLowerCase().includes(kw)) {
          chosen = i;
          break outer;
        }
      }
    }

    console.log(`[FORM] → нажимаем [${chosen}]: "${buttons[chosen]?.text}"`);
    client.queue("modal_form_response", {
      id: formId,
      canceled: false,
      data: String(chosen),
    });
  }

  console.log(`[FORM] ══════════════════════════════\n`);
});

// Лог чата — следим за сообщениями об авторизации
client.on("text", (packet) => {
  const msg =
    packet.message ||
    (packet.parameters ? packet.parameters.join("") : "") ||
    "";
  if (!msg) return;
  console.log(`[CHAT] ${msg}`);

  const lower = msg.toLowerCase();
  if (
    lower.includes("успешно") || lower.includes("добро пожаловать") ||
    lower.includes("авторизован") || lower.includes("вошли") ||
    lower.includes("welcome") || lower.includes("logged in") ||
    lower.includes("authorized")
  ) {
    authState.authorized = true;
    console.log(`[BOT] ✅ Авторизация прошла успешно!`);
  }
  if (lower.includes("неверный пароль") || lower.includes("wrong password") || lower.includes("incorrect")) {
    console.log(`[BOT] ⚠️  Неверный пароль — проверь пароль`);
  }
});

client.on("disconnect", (reason) => {
  const msg = reason?.message || reason?.reason || JSON.stringify(reason) || "Unknown";
  console.log(`[BOT] ❌ Отключён: ${msg}`);
  process.exit(0);
});

client.on("error", (err) => {
  console.error(`[BOT] Ошибка: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("[BOT] Завершение...");
  client.disconnect();
  process.exit(0);
});
