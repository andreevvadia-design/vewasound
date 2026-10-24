/**
 * =====================================================================
 *  VEWASOUND TELEGRAM BOT FOR GOOGLE APPS SCRIPT
 * =====================================================================
 * 
 * - Instant 6-digit confirmation code delivery
 * - Resilient HTML formatting for Telegram messages
 * - Automatic real-time user logging in Google Sheets
 * =====================================================================
 */

// ВСТАВЬТЕ СЮДА ТОКЕН ВАШЕГО БОТА ИЗ @BotFather:
const BOT_TOKEN = "ВАШ_ТОКЕН_ОТ_BOTFATHER";

// ССЫЛКА НА ВАШ САЙТ VEWASOUND (ОБЯЗАТЕЛЬНО HTTPS ДЛЯ MINI APP):
// Например, ссылка с Render.com: "https://vewasound.onrender.com"
const MINI_APP_URL = "";

/**
 * Обработка входящих сообщений от Telegram (Вебхук)
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput("OK");
    }

    const data = JSON.parse(e.postData.contents);

    // 0. Дедупликация повторов от Telegram (защита от спама и повторных ретраев)
    const cache = CacheService.getScriptCache();
    if (data.update_id) {
      const updateKey = "upd_" + data.update_id;
      if (cache.get(updateKey)) {
        return ContentService.createTextOutput("OK");
      }
      cache.put(updateKey, "1", 300); // 5 минут кеша
    }

    const msg = data.message || data.channel_post || (data.callback_query ? data.callback_query.message : null);
    if (!msg) return ContentService.createTextOutput("OK");

    const fromUser = (data.callback_query ? data.callback_query.from : msg.from) || {};
    const chatId = msg.chat ? msg.chat.id : fromUser.id;
    const userId = String(fromUser.id || chatId);

    // Debounce защита от случайных дабл-кликов
    const debounceKey = "deb_" + userId;
    if (cache.get(debounceKey)) {
      return ContentService.createTextOutput("OK");
    }
    cache.put(debounceKey, "1", 2);

    const sheet = getOrCreateUsersSheet();
    const incomingText = String((data.callback_query ? data.callback_query.data : msg.text) || "").trim();
    const isRequestNewCode = incomingText.includes("новый код") || incomingText === "/code" || incomingText === "🔑 Получить новый код";

    // Проверяем, авторизован ли уже пользователь в Google Таблице
    const sheetData = sheet.getDataRange().getValues();
    let existingUser = null;

    for (let i = 1; i < sheetData.length; i++) {
      if (String(sheetData[i][0]) === userId) {
        existingUser = {
          id: String(sheetData[i][0]),
          username: String(sheetData[i][1]),
          name: String(sheetData[i][2]),
          code: String(sheetData[i][4] || sheetData[i][3] || ""),
          date: String(sheetData[i][5] || sheetData[i][4] || ""),
          status: String(sheetData[i][6] || sheetData[i][5] || "")
        };
        break;
      }
    }

    // ЕСЛИ ПОЛЬЗОВАТЕЛЬ УЖЕ АВТОРИЗОВАН И НЕ ПРОСИТ КОД СПЕЦИАЛЬНО:
    if (existingUser && existingUser.status.indexOf("Авторизован") !== -1 && !isRequestNewCode) {
      const alreadyAuthMsg = 
        "✅ <b>Вы уже успешно авторизованы в VewaSound!</b>\n\n" +
        "Ваш аккаунт подключен к сайту. Приятного прослушивания музыки! 🎧";

      const keyboard = [];
      if (MINI_APP_URL && MINI_APP_URL.startsWith("https://")) {
        keyboard.push([{ text: "🎧 Открыть плеер VewaSound", web_app: { url: MINI_APP_URL } }]);
      }
      keyboard.push([{ text: "🔑 Получить новый код" }]);

      sendTelegramKeyboard(chatId, alreadyAuthMsg, keyboard);
      if (data.callback_query) {
        answerCallbackQuery(data.callback_query.id, "Вы уже авторизованы");
      }
      return ContentService.createTextOutput("OK");
    }

    // Юзернейм и имя
    const username = fromUser.username ? ("@" + fromUser.username) : "(нет юзернейма)";
    const fullName = [fromUser.first_name || "", fromUser.last_name || ""].join(" ").trim() || "Слушатель";
    const dateStr = Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM.yyyy HH:mm:ss");

    // Генерируем 6-значный проверочный код
    const verificationCode = String(Math.floor(100000 + Math.random() * 900000));

    // Текст сообщения для пользователя (HTML-разметка — работает мгновенно и без ошибок)
    const replyMessage = 
      "🎧 <b>VewaSound</b>\n\n" +
      "🔑 <b>Ваш проверочный код для входа на сайт:</b>\n\n" +
      "<code>" + verificationCode + "</code>\n\n" +
      "<i>(нажмите на код, чтобы скопировать)</i>\n\n" +
      "Введите этот 6-значный код на сайте VewaSound.";

    // Кнопки для пользователя (включая Mini App, если указан HTTPS URL)
    const keyboard = [];
    if (MINI_APP_URL && MINI_APP_URL.startsWith("https://")) {
      keyboard.push([{ text: "🎧 Открыть плеер VewaSound", web_app: { url: MINI_APP_URL } }]);
    }
    keyboard.push([{ text: "🔑 Получить новый код" }]);

    // 1. СНАЧАЛА МГНОВЕННО ОТПРАВЛЯЕМ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЮ В TELEGRAM
    sendTelegramKeyboard(chatId, replyMessage, keyboard);

    // 2. ЗАТЕМ СОХРАНЯЕМ ДАННЫЕ В GOOGLE ТАБЛИЦУ
    saveOrUpdateUserInSheet(sheet, {
      id: userId,
      username: username,
      name: fullName,
      code: verificationCode,
      date: dateStr,
      status: "Ожидает ввода на сайте"
    });

    if (data.callback_query) {
      answerCallbackQuery(data.callback_query.id, "Код: " + verificationCode);
    }

    return ContentService.createTextOutput("OK");
  } catch (err) {
    Logger.log("doPost Error: " + err.toString());
    return ContentService.createTextOutput("Error: " + err.toString());
  }
}

/**
 * Обработка GET-запросов (проверка кода с сайта и настройка вебхука)
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action;

    // 1. Проверка кода авторизации с сайта VewaSound
    if (action === "verify") {
      const code = String(params.code || "").trim();
      if (!code) {
        return createJsonResponse({ success: false, error: "Код подтверждения не передан" });
      }

      const sheet = getOrCreateUsersSheet();
      const data = sheet.getDataRange().getValues();
      let matchedUser = null;
      let targetRow = -1;

      // Ищем код в строках
      for (let i = 1; i < data.length; i++) {
        // Проверяем 4-ю и 5-ю колонки (на случай разных версий таблицы)
        const codeInCol4 = String(data[i][4] || "").trim();
        const codeInCol3 = String(data[i][3] || "").trim();

        if (codeInCol4 === code || codeInCol3 === code) {
          matchedUser = {
            id: String(data[i][0]),
            username: String(data[i][1]),
            name: String(data[i][2]),
            code: code,
            date: String(data[i][5] || data[i][4] || ""),
            status: "Авторизован"
          };
          targetRow = i + 1;
          break;
        }
      }

      if (matchedUser) {
        // Обновляем статус в последней колонке
        const lastCol = sheet.getLastColumn();
        sheet.getRange(targetRow, lastCol).setValue("Успешно авторизован на сайте");

        return createJsonResponse({
          success: true,
          user: matchedUser,
          message: "Успешная авторизация"
        });
      } else {
        return createJsonResponse({
          success: false,
          error: "Неверный код подтверждения. Нажмите «Получить новый код» в боте."
        });
      }
    }

    // 2. Быстрая установка вебхука в 1 клик (с очисткой зависших очередей Telegram)
    if (action === "setWebhook") {
      const currentUrl = ScriptApp.getService().getUrl();
      const token = (params.token && params.token !== "") ? params.token : BOT_TOKEN;

      if (!token || token.includes("ВАШ_ТОКЕН")) {
        return ContentService.createTextOutput("ОШИБКА: Замените BOT_TOKEN в начале скрипта на токен от @BotFather!");
      }

      const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/setWebhook?url=" + encodeURIComponent(currentUrl) + "&drop_pending_updates=true", {
        muteHttpExceptions: true
      });
      return ContentService.createTextOutput("Вебхук Telegram успешно настроен и очередь очищена!\nОтвет Telegram API:\n" + res.getContentText());
    }

    // 3. Получение списка пользователей (для просмотра)
    if (action === "getUsers") {
      const sheet = getOrCreateUsersSheet();
      const data = sheet.getDataRange().getValues();
      const list = [];
      for (let i = 1; i < data.length; i++) {
        list.push({
          id: data[i][0],
          username: data[i][1],
          name: data[i][2],
          code: data[i][4] || data[i][3],
          date: data[i][5] || data[i][4],
          status: data[i][6] || data[i][5]
        });
      }
      return createJsonResponse({ success: true, count: list.length, users: list });
    }

    return createJsonResponse({
      status: "VewaSound Telegram Bot Web App is operational",
      time: new Date().toISOString()
    });

  } catch (err) {
    return createJsonResponse({ success: false, error: err.toString() });
  }
}

/**
 * Создает или получает вкладку "Пользователи" в Google Таблице
 */
function getOrCreateUsersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Пользователи");

  if (!sheet) {
    sheet = ss.insertSheet("Пользователи");
    const headers = [
      "Telegram ID",
      "Юзернейм (@username)",
      "Имя Фамилия",
      "Код подтверждения",
      "Дата и время запроса",
      "Статус авторизации"
    ];

    sheet.appendRow(headers);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#111116");
    headerRange.setFontColor("#2AABEE");
    headerRange.setHorizontalAlignment("center");

    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 140);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(3, 190);
    sheet.setColumnWidth(4, 160);
    sheet.setColumnWidth(5, 170);
    sheet.setColumnWidth(6, 220);
  }

  return sheet;
}

/**
 * Сохраняет или обновляет запись пользователя в Google Таблице
 */
function saveOrUpdateUserInSheet(sheet, u) {
  try {
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(u.id)) {
        rowIndex = i + 1;
        break;
      }
    }

    // Проверяем количество колонок в таблице
    const cols = sheet.getLastColumn();

    if (cols >= 7) {
      // 7-колоночный формат (если была колонка телефона)
      if (rowIndex > 0) {
        sheet.getRange(rowIndex, 1, 1, 7).setValues([[
          u.id,
          u.username,
          u.name,
          "—",
          u.code,
          u.date,
          u.status
        ]]);
      } else {
        sheet.appendRow([u.id, u.username, u.name, "—", u.code, u.date, u.status]);
      }
    } else {
      // 6-колоночный формат (ID, Username, Name, Code, Date, Status)
      if (rowIndex > 0) {
        sheet.getRange(rowIndex, 1, 1, 6).setValues([[
          u.id,
          u.username,
          u.name,
          u.code,
          u.date,
          u.status
        ]]);
      } else {
        sheet.appendRow([u.id, u.username, u.name, u.code, u.date, u.status]);
      }
    }
  } catch (err) {
    Logger.log("Save error: " + err.toString());
  }
}

/**
 * Отправка сообщения с клавиатурой пользователю в Telegram (HTML разметка)
 */
function sendTelegramKeyboard(chatId, htmlText, keyboardRows) {
  const payload = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    reply_markup: {
      keyboard: keyboardRows,
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };

  try {
    UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("Send telegram message error: " + e.toString());
  }
}

/**
 * Ответ на callback query
 */
function answerCallbackQuery(callbackQueryId, text) {
  try {
    UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/answerCallbackQuery", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text
      }),
      muteHttpExceptions: true
    });
  } catch (e) {}
}

/**
 * Вспомогательная функция ответа в формате JSON с заголовками CORS
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
