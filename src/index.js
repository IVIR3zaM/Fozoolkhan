// Lambda handler for فضول‌خان (Fozoolkhan).
//
// Milestone 4: on an addressed message, call Claude Haiku via Bedrock with the
// Persian personality system prompt and reply to the triggering message. We also
// keep the milestone-3 behaviour of recording the sender's PROFILE item.
//
// Secrets come from environment variables, never from a committed file:
//   - TELEGRAM_SECRET_TOKEN verifies the webhook header.
//   - TELEGRAM_BOT_TOKEN authenticates outgoing Bot API calls.
//   - BOT_USERNAME (not a secret, but kept in env to match) is the bot's
//     Telegram @username, used to detect mentions.
//   - DDB_TABLE_NAME is the single DynamoDB table.

import { recordSighting, getProfile } from "./db.js";
import { generateReply } from "./bedrock.js";
import { sendMessage } from "./telegram.js";

// Telegram sends this header on every webhook request when a secret token is
// configured. Function URL lowercases all header names.
const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

// A plain 200 with no body. Telegram only cares that we answered 2xx quickly.
const ok = { statusCode: 200, body: "" };

/**
 * Decide whether the bot should respond to a message. True only when the bot
 * was @-mentioned by username, or the message is a reply to one of the bot's
 * own messages. Everything else is ignored.
 *
 * @param {object} message  Telegram `message` object.
 * @param {string} botUsername  The bot's @username (without the leading @).
 */
const shouldRespond = (message, botUsername) => {
  if (!message || !botUsername) return false;

  // Reply to one of the bot's messages. The bot is identified by its username
  // on the replied-to message's author.
  const repliedTo = message.reply_to_message?.from;
  if (repliedTo?.username === botUsername) return true;

  // @-mention by username. Mentions live in `entities` (text) or
  // `caption_entities` (media captions); the mentioned text is sliced out of
  // the message text/caption by the entity's offset and length.
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const wanted = `@${botUsername}`.toLowerCase();
  for (const entity of entities) {
    if (entity.type !== "mention") continue;
    const mentioned = text.substr(entity.offset, entity.length).toLowerCase();
    if (mentioned === wanted) return true;
  }

  return false;
};

/**
 * AWS Lambda Function URL handler.
 *
 * @param {object} event Function URL (payload format 2.0) event.
 */
export const handler = async (event) => {
  const headers = event?.headers ?? {};
  const expectedToken = process.env.TELEGRAM_SECRET_TOKEN;

  // Reject anything that does not present the correct secret token. We still
  // answer 200 so Telegram does not retry, but we do no work.
  if (!expectedToken || headers[SECRET_TOKEN_HEADER] !== expectedToken) {
    console.warn("Rejected webhook: missing or invalid secret token.");
    return ok;
  }

  // The body may arrive base64-encoded depending on content type.
  let rawBody = event?.body ?? "";
  if (event?.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, "base64").toString("utf8");
  }

  let update;
  try {
    update = JSON.parse(rawBody);
  } catch (err) {
    console.warn("Rejected webhook: body is not valid JSON.", err?.message);
    return ok;
  }

  console.log("Telegram update:", JSON.stringify(update));

  // Only plain messages can mention or reply to the bot. Edited messages and
  // other update kinds are ignored.
  const message = update?.message;
  if (!shouldRespond(message, process.env.BOT_USERNAME)) {
    // Not addressed to us — stay silent but acknowledge the webhook.
    return ok;
  }

  console.log("Bot was addressed (mention or reply); generating a reply.");

  // Code-owned structure: record the sender into their PROFILE item and read it
  // back by numeric user_id. (Profile-aware context is a later milestone.)
  try {
    await recordSighting(message.from);
    const profile = await getProfile(message.from.id);
    console.log("Profile after sighting:", JSON.stringify(profile));
  } catch (err) {
    // A storage hiccup must not turn into a Telegram retry storm.
    console.error("Failed to record/read profile:", err?.message);
  }

  // Generate an in-character Persian reply and send it back, threaded under the
  // triggering message. Errors are swallowed so Telegram does not retry.
  try {
    const userText = message.text ?? message.caption ?? "";
    const reply = await generateReply(userText);
    if (reply) {
      await sendMessage(message.chat.id, reply, message.message_id);
    }
  } catch (err) {
    console.error("Failed to generate/send reply:", err?.message);
  }

  return ok;
};
