// Configuration constants for فضول‌خان (Fozoolkhan).
//
// Copy this file to `config.js` and adjust. `config.js` is gitignored.
// Real secrets (bot token, Telegram secret token) come from ENVIRONMENT
// VARIABLES at runtime — never commit them.

export const config = {
  // The #1 product requirement: monthly cost ceiling, in euros.
  // The in-code spend guard refuses to call Bedrock once this is exceeded.
  MONTHLY_BUDGET_EUR: 5,

  // Bedrock model. Kept as a single constant so it can be swapped easily.
  // Default: Claude Haiku — cheapest with acceptable Persian humor.
  BEDROCK_MODEL_ID: "anthropic.claude-3-5-haiku-20241022-v1:0",

  // Hard cap on response length to keep token spend down.
  MAX_RESPONSE_TOKENS: 300,

  // Per-1K-token prices in euros, used to estimate each call's cost for the
  // monthly spend counter. Defaults match Claude 3.5 Haiku on Bedrock; adjust
  // if the model or EUR/USD rate changes.
  BEDROCK_INPUT_PRICE_PER_1K_EUR: 0.0008,
  BEDROCK_OUTPUT_PRICE_PER_1K_EUR: 0.004,

  // How many recent messages to include as context (never full history).
  CONTEXT_MESSAGE_COUNT: 5,

  // Append-only observation log. OBS_TTL_DAYS is how long each one-line
  // observation lives before DynamoDB TTL auto-expires it (enable TTL on the
  // `ttl` attribute). OBS_SUMMARY_THRESHOLD is how many observations accumulate
  // before the occasional summarization step folds them into a profile summary.
  OBS_TTL_DAYS: 30,
  OBS_SUMMARY_THRESHOLD: 8,

  // The bot's Telegram username (without @), used to detect mentions.
  BOT_USERNAME: "fozoolkhan",

  // ACCESS CONTROL: the admin's numeric Telegram user id. The bot answers only
  // this user in private chats, DMs them to approve any group the bot is added
  // to, and only this user can tap the approve/deny buttons. Get it by messaging
  // @userinfobot, or read it from the Lambda logs (`message.from.id`). The admin
  // must have started a private chat with the bot first, or the approval DM
  // can't be delivered.
  ADMIN_USER_ID: "123456789",

  // DynamoDB single-table name.
  DDB_TABLE_NAME: "fozoolkhan",

  // Placeholder ONLY. The real value is read from an environment variable
  // (e.g. process.env.TELEGRAM_SECRET_TOKEN) and used to verify incoming
  // webhook requests. Do not commit the real token.
  TELEGRAM_SECRET_TOKEN: "set-via-environment-variable",

  // Placeholder ONLY. The bot token from @BotFather, read from an environment
  // variable (process.env.TELEGRAM_BOT_TOKEN) to authenticate outgoing Bot API
  // calls (e.g. sending replies). Do not commit the real token.
  TELEGRAM_BOT_TOKEN: "set-via-environment-variable",
};
