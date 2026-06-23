// Bedrock (Claude Haiku) access for فضول‌خان (Fozoolkhan).
//
// Milestone 4: call Claude Haiku via Bedrock with the Persian personality system
// prompt and return the reply text. `max_tokens` is always capped to keep token
// spend down (token frugality is a hard rule — see AGENTS.md).
// Milestone 5: the reply is generated from assembled context — the last few
// messages plus the speaker's profile snippet — never full history.
// Milestone 8: the same reply call also emits a one-line observation about the
// speaker (piggybacked, so it costs one call, not two), which code appends to
// the OBS# log. A separate, occasional summarizeObservations() call compresses
// accumulated observations into a person's free-text profile summary.
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
// The humor boundary (AGENTS.md) is baked in as a trait of a clever friend in a
// crude all-male friends' group — colloquial and salty like the rest of them,
// but it still never goes low at a real group member.
const SYSTEM_PROMPT = `تو «فضول‌خان» هستی، یه عضو از یه گروه رفاقتیِ مردونه تو تلگرام. لحن گروه خودمونی، شوخ و گاهی رکیکه و تو هم دقیقاً مثل بقیه حرف می‌زنی.

شخصیتت:
- محاوره‌ای، سریع، حاضرجواب و تیکه‌انداز؛ مثل رفیقی که باهاشون راحته.
- لحنت کاملاً خودمونیه، نه مودب و رسمی. «جان» و تعارف و لحنِ پاستوریزه ممنوع — اینجا کسی این‌جوری حرف نمی‌زنه.
- فحش و شوخیِ رکیکِ رفاقتی (در همون حد و حالِ خودِ بچه‌های گروه) اوکیه و وقتی یکی بهت تیکه انداخت می‌تونی متقابلاً جوابِ سنگین بدی؛ ولی هیچ‌وقت توهینِ جنسی یا تحقیرِ واقعی و شخصی به یه عضوِ واقعیِ گروه نکن. شوخی رو می‌بری سرِ موقعیت و حرف، نه سرِ نقطه‌ضعفِ واقعیِ آدم‌ها.
- این گروه اصولاً از سیاست‌مدارها دلِ خوشی نداره و زیاد سرِ شخصیت‌های سیاسی شوخی می‌کنه؛ پس در موردِ سیاست‌مدارها و آدمای قدرت دستت بازه: مسخره کن، تیکه بنداز، حتی توهینِ خنده‌دار بکن. این‌جور شوخی‌های سیاسی اینجا کاملاً سرِ جاشه.
- فارسیِ روان و طبیعی حرف بزن؛ پرت‌وپلا و جمله‌ی نامفهوم ننویس.
- کوتاه جواب بده، نهایت چند جمله.

به متنِ گفتگو دقت کن: اگه به یه پیام ریپلای شده یا ازت در موردِ یه پیام یا یه نفر نظر خواستن، دقیقاً در موردِ همون حرف بزن، نه یه جوابِ کلی و بی‌ربط. پیام‌هایی که با «فضول‌خان (خودت)» مشخص شدن حرف‌های خودتن؛ یادت باشه قبلاً چی گفتی، رشته‌ی شوخی رو ادامه بده و خودت رو تکرار نکن.`;

// The character for the separate, occasional summarization step. It only ever
// produces the free-text profile summary — never structured data — so the prompt
// keeps it to a couple of plain sentences with no preamble.
const SUMMARY_SYSTEM_PROMPT = `تو نکته‌های پراکنده‌ای را که فضول‌خان درباره‌ی یک عضو گروه جمع کرده می‌گیری و در نهایت دو-سه جمله‌ی کوتاه فارسی فشرده می‌کنی: عادت‌ها، علاقه‌ها و نوع شوخی‌هایی که با او می‌گیره. فقط همان خلاصه را بنویس، بدون مقدمه و بدون فهرست.`;

// Delimiter the model puts before its memory observations, so code can split the
// user-facing reply from the observation lines it appends to the OBS# log. Chosen
// so it never shows up in normal Persian chat.
const OBS_DELIMITER = "###OBS###";

// Delimiter the model puts before its coreference answers (Layer 2): when we
// couldn't resolve a spoken name, the model may tell us which person *in the
// transcript* it refers to. Code (not the model) then maps that display label
// back to a numeric id and writes the alias. Same "never appears in chat" design.
const ALIAS_DELIMITER = "###ALIAS###";

/**
 * Parse the coreference block that follows ALIAS_DELIMITER into per-name pairs.
 * Each line is `spokenName = labelInChat` — the spoken name the asker used, and
 * the display label of the person in the transcript the model says it refers to.
 * Code owns turning the label into a numeric id; here we only split the prose.
 *
 * @param {string} block  Raw text after the delimiter (may be empty).
 * @returns {Array<{name: string, label: string}>}
 */
export const parseAliasBlock = (block) => {
  const out = [];
  for (const rawLine of String(block ?? "").split("\n")) {
    const line = rawLine.replace(/^[-*•\s]+/, "").trim();
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue; // need a non-empty spoken name before the equals.
    const name = line.slice(0, idx).trim();
    const label = line.slice(idx + 1).trim();
    if (name && label) out.push({ name, label });
    if (out.length >= 4) break; // frugal cap.
  }
  return out;
};

/**
 * Split a raw completion into the user-facing reply and its two control blocks
 * (observations, aliases), in whatever order the model emitted them. The reply is
 * everything before the first delimiter; each block runs from its delimiter to the
 * next delimiter (or end). A missing delimiter just yields an empty block, so a
 * control section never leaks into the chat.
 *
 * @param {string} raw  The model's raw completion.
 * @returns {{ text: string, obsBlock: string, aliasBlock: string }}
 */
export const splitControlBlocks = (raw) => {
  const s = String(raw ?? "");
  const oi = s.indexOf(OBS_DELIMITER);
  const ai = s.indexOf(ALIAS_DELIMITER);

  const present = [oi, ai].filter((i) => i >= 0);
  const replyEnd = present.length ? Math.min(...present) : s.length;
  const text = s.slice(0, replyEnd).trim();

  // A block ends at the next delimiter that starts after it (the other one).
  const blockFrom = (start, otherStart) => {
    if (start < 0) return "";
    const begin =
      start + (start === oi ? OBS_DELIMITER : ALIAS_DELIMITER).length;
    const end = otherStart > begin ? otherStart : s.length;
    return s.slice(begin, end);
  };

  return {
    text,
    obsBlock: blockFrom(oi, ai),
    aliasBlock: blockFrom(ai, oi),
  };
};

/**
 * Parse the observation block that follows OBS_DELIMITER into per-person lines.
 * Each line is `name: note` — `name` is whoever the note is about (the speaker,
 * or a third person named in the chat). Code (not this function) owns turning a
 * name into a numeric user id; here we only split prose into (name, note) pairs.
 *
 * @param {string} block  Raw text after the delimiter (may be empty).
 * @returns {Array<{name: string, note: string}>}
 */
export const parseObservationBlock = (block) => {
  const out = [];
  for (const rawLine of String(block ?? "").split("\n")) {
    const line = rawLine.replace(/^[-*•\s]+/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // need a non-empty name before the colon.
    const name = line.slice(0, idx).trim();
    const note = line.slice(idx + 1).trim();
    if (name && note) out.push({ name, note });
    if (out.length >= 4) break; // frugal cap.
  }
  return out;
};

// Pull the concatenated text and an estimated euro cost out of a Bedrock Claude
// response payload. Shared by every call so cost accounting stays uniform (the
// estimate feeds the spend guard's monthly counter).
const parseCompletion = (payload) => {
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  const inputTokens = payload.usage?.input_tokens ?? 0;
  const outputTokens = payload.usage?.output_tokens ?? 0;
  const costEur =
    (inputTokens / 1000) * inputPricePer1K() +
    (outputTokens / 1000) * outputPricePer1K();

  return { text, costEur };
};

// Render one transcript line, marking the bot's own past messages distinctly so
// the model knows which lines it said itself (and doesn't repeat them or mistake
// them for someone else's). `self` is set by code when the line is the bot's.
const renderLine = (m) =>
  m?.self ? `فضول‌خان (خودت): ${m.text}` : `${m?.name ?? "یه نفر"}: ${m?.text}`;

/**
 * Build the single user turn from assembled context: a compact transcript of the
 * recent messages (oldest first, the triggering message last), the message being
 * replied to (if any), and a short snippet about the person the bot is replying
 * to. Kept tight on purpose.
 *
 * @param {object} ctx
 * @param {Array<{name: string, text: string, self?: boolean}>} [ctx.recentMessages]
 * @param {{name: string, text: string, self?: boolean}} [ctx.replyTo]  The
 *   message the triggering message is a reply to, so the bot comments on the
 *   actual referenced post — not just on its own mention.
 * @param {string} [ctx.profileSnippet]  Context about the *speaker* — the person
 *   the bot is replying to.
 * @param {string[]} [ctx.subjectSnippets]  Context about the people the speaker is
 *   asking *about* (distinct from the speaker, so the bot doesn't address them).
 * @param {string} [ctx.nameNote]  Optional code-owned note (e.g. an ambiguity hint).
 * @param {string[]} [ctx.unresolvedNames]  Spoken names the code couldn't resolve;
 *   the model is asked to map them to a person in the transcript (Layer 2).
 * @returns {string}
 */
export const buildUserContent = ({
  recentMessages,
  replyTo,
  profileSnippet,
  subjectSnippets,
  nameNote,
  unresolvedNames,
} = {}) => {
  const lines = [];

  if (recentMessages?.length) {
    lines.push(
      "گفتگوی اخیر گروه (قدیمی‌ترین بالا، آخرین خط همون پیامیه که الان باید جوابش بدی):",
    );
    for (const m of recentMessages) lines.push(renderLine(m));
  }

  if (replyTo?.text) {
    lines.push("");
    lines.push(
      "این پیام، ریپلای به این پیامِ قبلیه؛ نظرت رو دقیقاً در موردِ همین بده:",
    );
    lines.push(renderLine(replyTo));
  }

  if (profileSnippet) {
    lines.push("");
    lines.push(
      `گوینده‌ی پیام که الان داری بهش جواب می‌دی همینه؛ نکته‌ای درباره‌ش: ${profileSnippet}`,
    );
  }

  if (subjectSnippets?.length) {
    lines.push("");
    lines.push(
      "گوینده داره ازت درباره‌ی این آدم(ها) می‌پرسه. حواست باشه: جوابت رو به خودِ گوینده بده، نه به این‌ها؛ فقط درباره‌شون حرف بزن:",
    );
    for (const s of subjectSnippets) lines.push(`- ${s}`);
  }

  if (nameNote) {
    lines.push("");
    lines.push(nameNote);
  }

  lines.push("");
  lines.push("حالا به‌عنوان فضول‌خان کوتاه و بامزه جواب بده.");
  lines.push(
    `بعد از جواب، یه خطِ جدا «${OBS_DELIMITER}» بذار و بعدش — فقط اگه نکته‌ی تازه‌ای بود — برای حافظه‌ی خودت یادداشت کن؛ هر نکته تو یه خط، به شکلِ «اسمِ شخص: نکته». می‌تونی هم درباره‌ی گوینده‌ی پیام بنویسی هم درباره‌ی کسی که توی حرفا ازش اسم برده شده (مثلاً وقتی یکی درباره‌ی یه نفرِ دیگه نظری میده). اگه نکته‌ای نبود، چیزی ننویس. این بخش به کسی نشون داده نمی‌شه.`,
  );

  // Layer 2 (coreference): only when code couldn't resolve a spoken name. Ask the
  // model to map it to someone *named in the transcript above*, so code can learn
  // the alias. Kept out of the prompt entirely otherwise (token frugality).
  if (unresolvedNames?.length) {
    lines.push("");
    lines.push(
      `این اسم‌(ها) رو نشناختم: ${unresolvedNames.join("، ")}. اگه از روی همین گفتگو مطمئنی هرکدوم اسم/لقبِ یکی از همون آدم‌هاست که بالا توی گفتگو حرف زده، یه خطِ جدا «${ALIAS_DELIMITER}» بذار و هرکدوم رو به شکلِ «اسمی که پرسیده شد = همون اسمی که اون آدم توی گفتگو باهاش نوشته شده» بنویس. فقط وقتی مطمئنی؛ وگرنه چیزی ننویس. این بخش هم به کسی نشون داده نمی‌شه.`,
    );
  }

  return lines.join("\n");
};

/**
 * Ask Claude Haiku to reply in-character, given assembled context.
 *
 * @param {object} context
 * @param {Array<{name: string, text: string, self?: boolean}>} [context.recentMessages]
 *   Last few messages, oldest first; the triggering message is the final entry.
 *   `self` marks the bot's own past lines.
 * @param {{name: string, text: string, self?: boolean}} [context.replyTo]  The
 *   message being replied to, so the bot comments on the referenced post.
 * @param {string} [context.profileSnippet]  Short note about the person the bot
 *   is replying to (the speaker, or the resolved subject of their question).
 * @param {string} [context.nameNote]  Optional code-owned note, e.g. an
 *   ambiguity hint when a spoken name matched several people.
 * @param {string[]} [context.unresolvedNames]  Spoken names code couldn't resolve;
 *   the model is asked to map each to a person named in the transcript (Layer 2).
 * @returns {Promise<{text: string, observations: Array<{name: string, note: string}>, aliases: Array<{name: string, label: string}>, costEur: number, systemPrompt: string, userPrompt: string, raw: string}>}
 *   The bot's Persian reply, zero or more observations each tagged with the spoken
 *   name of the person they're about, zero or more coreference aliases (spoken name
 *   → a display label in the transcript, which code maps to a user id), and an
 *   estimated euro cost (for the monthly spend counter). The exact prompts sent and
 *   the raw completion are also returned, for the admin debug dump.
 */
export const generateReply = async (context = {}) => {
  const userPrompt = buildUserContent(context);
  const command = new InvokeModelCommand({
    modelId: modelId(),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens(),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const response = await client.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));
  const { text: raw, costEur } = parseCompletion(payload);

  // Split the user-facing reply from the piggybacked control blocks. If the model
  // omitted a delimiter that block is empty — so a missing observation or alias
  // never leaks into the chat.
  const { text, obsBlock, aliasBlock } = splitControlBlocks(raw);
  const observations = parseObservationBlock(obsBlock);
  const aliases = parseAliasBlock(aliasBlock);

  return {
    text,
    observations,
    aliases,
    costEur,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    raw,
  };
};

/**
 * Compress a person's accumulated observations into a short free-text profile
 * summary — the separate, occasional summarization step (ARCHITECTURE.md). The
 * LLM only ever produces this prose; code decides it lands solely in the
 * `summary` field via setProfileSummary, never touching structured data.
 *
 * @param {object} input
 * @param {string} [input.summary]  The person's current summary, if any.
 * @param {string[]} [input.observations]  Accumulated one-line observations.
 * @returns {Promise<{summary: string, costEur: number, systemPrompt: string, userPrompt: string}>}
 *   The compressed summary, an estimated euro cost (for the monthly spend
 *   counter), and the exact prompts sent (for the admin debug dump).
 */
export const summarizeObservations = async ({ summary, observations } = {}) => {
  const lines = [];
  if (summary) {
    lines.push("خلاصه‌ی فعلی:");
    lines.push(summary);
    lines.push("");
  }
  lines.push("نکته‌های جمع‌شده:");
  for (const o of observations ?? []) lines.push(`- ${o}`);
  lines.push("");
  lines.push("خلاصه‌ی به‌روزشده را در دو-سه جمله بنویس.");
  const userPrompt = lines.join("\n");

  const command = new InvokeModelCommand({
    modelId: modelId(),
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens(),
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const response = await client.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));
  const { text, costEur } = parseCompletion(payload);
  return {
    summary: text,
    costEur,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userPrompt,
  };
};
