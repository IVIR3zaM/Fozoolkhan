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
 */
export const sendMessage = async (
  chatId,
  text,
  replyToMessageId,
  replyMarkup
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
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail}`);
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
      `Telegram answerCallbackQuery failed: ${response.status} ${detail}`
    );
  }
};
