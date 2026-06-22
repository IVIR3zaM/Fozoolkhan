// Lambda handler for فضول‌خان (Fozoolkhan).
//
// Milestone 1: accept a Telegram webhook POST via a Function URL, verify the
// Telegram secret token header, parse the update, log it, and return 200.
//
// The Telegram secret token is read from the TELEGRAM_SECRET_TOKEN environment
// variable — never from a committed file.

// Telegram sends this header on every webhook request when a secret token is
// configured. Function URL lowercases all header names.
const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

// A plain 200 with no body. Telegram only cares that we answered 2xx quickly.
const ok = { statusCode: 200, body: "" };

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

  // Milestone 1: just log the parsed update so it shows up in CloudWatch.
  console.log("Telegram update:", JSON.stringify(update));

  return ok;
};
