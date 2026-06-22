// Bedrock (Claude Haiku) access for فضول‌خان (Fozoolkhan).
//
// Milestone 4: call Claude Haiku via Bedrock with the Persian personality system
// prompt and return the reply text. `max_tokens` is always capped to keep token
// spend down (token frugality is a hard rule — see AGENTS.md).
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
 * Ask Claude Haiku to reply in-character to a message.
 *
 * @param {string} userText  The text the bot was addressed with.
 * @returns {Promise<string>} The bot's Persian reply.
 */
export const generateReply = async (userText) => {
  const command = new InvokeModelCommand({
    modelId: modelId(),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens(),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
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

  return text;
};
