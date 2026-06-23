// Telegram Bot API access for فضول‌خان (Fozoolkhan).
//
// Milestone 4: reply to the triggering message. The bot token is a secret and
// comes only from the environment (TELEGRAM_BOT_TOKEN) — never committed.

const apiBase = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Send a reply to a chat, threaded under the triggering message.
 *
 * @param {number|string} chatId  Target chat id.
 * @param {string} text  Reply text.
 * @param {number} [replyToMessageId]  Message to reply to, if any.
 * @param {object} [replyMarkup]  Optional inline keyboard / reply markup (e.g.
 *   the approve/deny buttons sent to the admin when added to a group).
 * @returns {Promise<object|undefined>} Telegram's `result` (the sent Message),
 *   so callers can read the new `message_id`; undefined if the body had none.
 */
export const sendMessage = async (
  chatId,
  text,
  replyToMessageId,
  replyMarkup,
) => {
  const body = { chat_id: chatId, text };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetch(`${apiBase()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Telegram sendMessage failed: ${response.status} ${detail}`,
    );
  }

  // The sent Message carries its new id, which the caller stores so a later reply
  // can be walked back up the thread. Tolerant of a body-less stub/response.
  try {
    const data = await response.json();
    return data?.result;
  } catch {
    return undefined;
  }
};

/**
 * Register the bot's slash-command list with Telegram so the client shows them
 * natively in the «/» command menu and autocompletes them. An optional `scope`
 * narrows who sees them (e.g. a single chat, so admin-only commands surface only
 * in the admin's DM). Best-effort — registration failing must not break a reply.
 *
 * @param {Array<{command: string, description: string}>} commands  Command list.
 * @param {object} [scope]  Telegram BotCommandScope (e.g. {type:"chat",chat_id}).
 */
export const setMyCommands = async (commands, scope) => {
  const body = { commands };
  if (scope) body.scope = scope;

  const response = await fetch(`${apiBase()}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Telegram setMyCommands failed: ${response.status} ${detail}`,
    );
  }
};

/**
 * Acknowledge a tapped inline button. Telegram shows a brief toast with `text`
 * and stops the button's loading spinner; without this the client spins until it
 * times out. Best-effort — a failure here must not break the approval flow.
 *
 * @param {string} callbackQueryId  The id from the incoming `callback_query`.
 * @param {string} [text]  Optional toast shown to the user who tapped.
 */
export const answerCallbackQuery = async (callbackQueryId, text) => {
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;

  const response = await fetch(`${apiBase()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Telegram answerCallbackQuery failed: ${response.status} ${detail}`,
    );
  }
};
