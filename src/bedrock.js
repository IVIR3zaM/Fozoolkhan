// Bedrock (Claude Haiku) access for فضول‌خان (Fozoolkhan).
//
// Milestone 4: call Claude Haiku via Bedrock with the Persian personality system
// prompt and return the reply text. `max_tokens` is always capped to keep token
// spend down (token frugality is a hard rule — see AGENTS.md).
// Milestone 5: the reply is generated from assembled context — the last few
// messages plus the speaker's profile snippet — never full history.
//
// Non-secret config (model id, token cap) comes from the environment with
// defaults that mirror config.example.js, matching how the rest of the code
// reads configuration. The model id is a single constant so it can be swapped.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// One shared client per Lambda container. Region is provided by Lambda.
const client = new BedrockRuntimeClient({});

const modelId = () =>
  process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0";
const maxTokens = () => Number(process.env.MAX_RESPONSE_TOKENS ?? 300);

// Per-1K-token prices in euros, used only to estimate spend for the monthly
// counter (the spend guard's brake). Defaults match Claude 3.5 Haiku on
// Bedrock; override via env if the model or FX rate changes.
const inputPricePer1K = () =>
  Number(process.env.BEDROCK_INPUT_PRICE_PER_1K_EUR ?? 0.0008);
const outputPricePer1K = () =>
  Number(process.env.BEDROCK_OUTPUT_PRICE_PER_1K_EUR ?? 0.004);

// The character. Persian voice on purpose: the bot must be funny *in Persian*.
// The humor boundary (AGENTS.md) is baked in as a trait of a clever friend who
// is too witty to need to go low — not as a bolted-on disclaimer.
const SYSTEM_PROMPT = `تو «فضول‌خان» هستی، یکی از اعضای باحال و حاضرجواب یک گروه دوستانه‌ی تلگرامی.
شخصیتت:
- شوخ، سریع، و کنایه‌زن مثل رفیقی که با همه صمیمیه.
- شوخی‌هات گرم و دوستانه‌ست؛ موقعیت و حرف‌ها رو دست می‌ندازی، نه نقطه‌ضعف واقعی آدم‌ها رو.
- هیچ‌وقت توهین جنسی یا تحقیر شخصی نسبت به آدم‌های واقعی نمی‌سازی، حتی اگه ازت بخوان؛ به‌جاش با یه شوخی بامزه‌تر و سبک‌تر در می‌ری. تو اون‌قدر باهوشی که نیازی به پایین‌آوردن سطح نداری.
- همیشه فارسی و کوتاه و بامزه جواب می‌دی. چند جمله بیشتر نه.`;

/**
 * Build the single user turn from assembled context: a compact transcript of
 * the recent messages (oldest first, the triggering message last) plus a short
 * snippet about the person the bot is replying to. Kept tight on purpose.
 *
 * @param {Array<{name: string, text: string}>} recentMessages
 * @param {string} profileSnippet
 * @param {string} [nameNote]  Optional code-owned note (e.g. an ambiguity hint).
 * @returns {string}
 */
const buildUserContent = (recentMessages, profileSnippet, nameNote) => {
  const lines = [];

  if (recentMessages?.length) {
    lines.push("گفتگوی اخیر گروه:");
    for (const m of recentMessages) lines.push(`${m.name}: ${m.text}`);
  }

  if (profileSnippet) {
    lines.push("");
    lines.push(`نکته‌ای درباره‌ی کسی که الان مخاطبته: ${profileSnippet}`);
  }

  if (nameNote) {
    lines.push("");
    lines.push(nameNote);
  }

  lines.push("");
  lines.push("حالا به‌عنوان فضول‌خان کوتاه و بامزه جواب بده.");

  return lines.join("\n");
};

/**
 * Ask Claude Haiku to reply in-character, given assembled context.
 *
 * @param {object} context
 * @param {Array<{name: string, text: string}>} [context.recentMessages]  Last
 *   few messages, oldest first; the triggering message is the final entry.
 * @param {string} [context.profileSnippet]  Short note about the person the bot
 *   is replying to (the speaker, or the resolved subject of their question).
 * @param {string} [context.nameNote]  Optional code-owned note, e.g. an
 *   ambiguity hint when a spoken name matched several people.
 * @returns {Promise<{text: string, costEur: number}>} The bot's Persian reply
 *   and an estimated euro cost (for the monthly spend counter).
 */
export const generateReply = async ({
  recentMessages,
  profileSnippet,
  nameNote,
} = {}) => {
  const command = new InvokeModelCommand({
    modelId: modelId(),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens(),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserContent(recentMessages, profileSnippet, nameNote),
        },
      ],
    }),
  });

  const response = await client.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));

  // Claude returns content blocks; concatenate the text blocks.
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // Estimate this call's euro cost from the usage Claude reports, so the spend
  // guard's monthly counter reflects real token consumption.
  const inputTokens = payload.usage?.input_tokens ?? 0;
  const outputTokens = payload.usage?.output_tokens ?? 0;
  const costEur =
    (inputTokens / 1000) * inputPricePer1K() +
    (outputTokens / 1000) * outputPricePer1K();

  return { text, costEur };
};
