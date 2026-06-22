// Lambda handler for فضول‌خان (Fozoolkhan).
//
// Milestone 5: every visible message is appended to a small rolling per-chat
// buffer. When the bot is addressed, it assembles tight context (the last few
// messages + the speaker's profile snippet) and replies — never full history.
// Milestone 6: a monthly spend guard runs before every Bedrock call. Once the
// running estimate passes MONTHLY_BUDGET_EUR the bot declines with a pre-written
// Persian line instead of calling Bedrock; each real call increments the counter.
//
// Secrets come from environment variables, never from a committed file:
//   - TELEGRAM_SECRET_TOKEN verifies the webhook header.
//   - TELEGRAM_BOT_TOKEN authenticates outgoing Bot API calls.
//   - BOT_USERNAME (not a secret, but kept in env to match) is the bot's
//     Telegram @username, used to detect mentions.
//   - DDB_TABLE_NAME is the single DynamoDB table.

import {
  recordSighting,
  recordMessage,
  getMonthlySpend,
  addMonthlySpend,
} from "./db.js";
import { generateReply } from "./bedrock.js";
import { sendMessage } from "./telegram.js";

// Pre-written Persian "broke until next month" line. Sent when the monthly
// spend guard trips, instead of calling Bedrock. Funny, never apologetic.
const BROKE_LINE =
  "این ماه دیگه پولم ته کشید، تا اول ماه بعد مهمونِ سکوتمی 😅 ولی دلم باهاته.";

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
  const messageText = message?.text ?? message?.caption ?? "";

  // Code-owned structure: append every visible message to the rolling per-chat
  // buffer (privacy mode is off, so we see them all). This is what lets us
  // assemble recent context later without ever sending full history.
  let recentMessages = null;
  if (message?.chat?.id && message?.from) {
    try {
      recentMessages = await recordMessage(
        message.chat.id,
        message.from,
        messageText
      );
    } catch (err) {
      // A storage hiccup must not turn into a Telegram retry storm.
      console.error("Failed to record recent message:", err?.message);
    }
  }

  if (!shouldRespond(message, process.env.BOT_USERNAME)) {
    // Not addressed to us — stay silent but acknowledge the webhook.
    return ok;
  }

  console.log("Bot was addressed (mention or reply); generating a reply.");

  // SPEND GUARD (must never be bypassed — see AGENTS.md): before any Bedrock
  // call, read the running monthly spend. If we're over the ceiling, reply with
  // the pre-written Persian line and do NOT call Bedrock. The counter is keyed
  // by month, so it resets at month rollover.
  const monthlyBudget = Number(process.env.MONTHLY_BUDGET_EUR ?? 5);
  try {
    const spent = await getMonthlySpend();
    if (spent >= monthlyBudget) {
      console.log(`Spend guard tripped: ${spent} >= ${monthlyBudget} EUR.`);
      await sendMessage(message.chat.id, BROKE_LINE, message.message_id);
      return ok;
    }
  } catch (err) {
    // If we can't read the counter we can't prove we're under budget — fail
    // closed and stay quiet rather than risk uncapped spend.
    console.error("Spend guard read failed; skipping Bedrock:", err?.message);
    return ok;
  }

  // Record the sender into their PROFILE item (code-owned, keyed by numeric
  // user_id) and use the returned profile to build a short context snippet.
  let profileSnippet = "";
  try {
    const profile = await recordSighting(message.from);
    const name = profile?.names_seen?.[0] ?? "";
    // For now `summary` is empty (filled by the later summarization milestone);
    // the name alone still tells the model who it is replying to.
    profileSnippet = [name, profile?.summary].filter(Boolean).join(" — ");
  } catch (err) {
    console.error("Failed to record/read profile:", err?.message);
  }

  // Generate an in-character Persian reply from the assembled context and send
  // it back, threaded under the triggering message. Errors are swallowed so
  // Telegram does not retry.
  try {
    const { text, costEur } = await generateReply({
      recentMessages,
      profileSnippet,
    });
    // Increment the monthly spend counter after every successful call (the
    // estimated euro cost from the call's token usage).
    await addMonthlySpend(costEur);
    if (text) {
      await sendMessage(message.chat.id, text, message.message_id);
    }
  } catch (err) {
    console.error("Failed to generate/send reply:", err?.message);
  }

  return ok;
};
