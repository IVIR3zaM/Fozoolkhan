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
 */
export const sendMessage = async (chatId, text, replyToMessageId) => {
  const body = { chat_id: chatId, text };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

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
