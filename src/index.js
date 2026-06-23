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
  recordBotMessage,
  getMonthlySpend,
  addMonthlySpend,
  getProfile,
  appendObservation,
  getObservations,
  setProfileSummary,
  getChatAccess,
  setChatAccess,
  listChatAccess,
  currentMonth,
} from "./db.js";
import {
  resolveName,
  resolveObservationTarget,
  describeAmbiguity,
  learnFromMessage,
} from "./names.js";
import { generateReply, summarizeObservations } from "./bedrock.js";
import {
  sendMessage,
  answerCallbackQuery,
  setMyCommands,
} from "./telegram.js";

// How many observations accumulate before the occasional summarization step
// folds them into a person's profile summary. Frugal: summarization is itself a
// Bedrock call, so it runs once every this-many observations, not every message.
const summaryThreshold = () => Number(process.env.OBS_SUMMARY_THRESHOLD ?? 8);

/**
 * Occasionally compress a person's accumulated observations into their free-text
 * profile summary. Runs only once a threshold of observations has accumulated, so
 * the extra Bedrock call is rare. It honours the spend guard and increments the
 * monthly counter; it never writes structured data (only setProfileSummary, the
 * summary field, is touched).
 *
 * @param {number|string} userId  The numeric user id to maybe summarize.
 * @param {number} monthlyBudget  Euro ceiling, for the spend guard re-check.
 */
const maybeSummarize = async (userId, monthlyBudget) => {
  if (!userId) return;

  const observations = await getObservations(userId);
  const count = observations.length;
  if (count === 0 || count % summaryThreshold() !== 0) return;

  // Spend guard is never bypassed: re-check before this extra Bedrock call.
  if ((await getMonthlySpend()) >= monthlyBudget) return;

  const profile = await getProfile(userId);
  const { summary, costEur } = await summarizeObservations({
    summary: profile?.summary,
    observations,
  });
  await addMonthlySpend(costEur);
  await setProfileSummary(userId, summary);
};

/**
 * Side effect after a reply (code-owned): for each observation the LLM emitted,
 * resolve the spoken name it's tagged with to a numeric user id and append the
 * note to that person's append-only OBS# log. This is what lets the bot learn
 * who someone is from what *others* say about them, not only from their own
 * words. Then — at most once per turn, for the speaker — fold accumulated
 * observations into the profile summary, to keep the extra Bedrock call rare.
 *
 * @param {object} speaker  The speaker's Telegram `from` object.
 * @param {Array<{name: string, note: string}>} observations  LLM-tagged notes.
 * @param {number} monthlyBudget  Euro ceiling, for the spend guard re-check.
 */
const rememberObservations = async (speaker, observations, monthlyBudget) => {
  if (!observations?.length) return;

  for (const { name, note } of observations) {
    const targetId = await resolveObservationTarget(
      speaker,
      name,
      process.env.BOT_USERNAME
    );
    if (targetId) await appendObservation(targetId, note);
  }

  // Bound the extra Bedrock cost: summarize at most one person per turn.
  await maybeSummarize(speaker?.id, monthlyBudget);
};

// Build a short context snippet from a profile: a name label plus the free-text
// summary (still empty until the summarization milestone). Code-owned structure.
const snippetOf = (profile) =>
  [profile?.names_seen?.[0], profile?.summary].filter(Boolean).join(" — ");

// Pre-written Persian "broke until next month" line. Sent when the monthly
// spend guard trips, instead of calling Bedrock. Funny, never apologetic.
export const BROKE_LINE =
  "این ماه دیگه پولم ته کشید، تا اول ماه بعد مهمونِ سکوتمی 😅 ولی دلم باهاته.";

// Telegram sends this header on every webhook request when a secret token is
// configured. Function URL lowercases all header names.
const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

// A plain 200 with no body. Telegram only cares that we answered 2xx quickly.
const ok = { statusCode: 200, body: "" };

// -----------------------------------------------------------------------------
// ACCESS CONTROL (token guard #1, before the spend guard).
//
// The bot is inert by default so strangers can't burn tokens:
//   - Private chats: only the admin (ADMIN_USER_ID) is answered. Everyone else
//     is ignored silently — no Bedrock, no storage.
//   - Groups: a group stays inert until the admin approves it. When the bot is
//     added to a group we DM the admin approve/deny buttons; only the approved
//     status unlocks recording/learning/replies for that group.
// ADMIN_USER_ID is the admin's numeric Telegram user id (a private chat's id
// equals the user's id, so it also works as the DM target).
// -----------------------------------------------------------------------------

// True when the given id is the configured admin. String-compared because env
// vars are strings and Telegram ids arrive as numbers.
export const isAdmin = (userId) =>
  Boolean(process.env.ADMIN_USER_ID) &&
  String(userId) === String(process.env.ADMIN_USER_ID);

// Pre-written Persian lines for the access-control flow (no Bedrock involved).
const ASK_APPROVAL = (title) =>
  `یکی منو به گروه «${title}» اضافه کرد. اینجا فعال باشم؟`;
const GROUP_APPROVED = "خب، از این به بعد اینجام؛ حواسم بهتون هست 😎";
const CB_APPROVED = "فعال شد ✅";
const CB_DENIED = "باشه، ساکت می‌مونم.";
const CB_NOT_ADMIN = "این دکمه مال تو نیست 😅";

// Inline keyboard for the admin's approve/deny DM. callback_data carries the
// target chat id (well under Telegram's 64-byte limit).
export const approvalKeyboard = (chatId) => ({
  inline_keyboard: [
    [
      { text: "✅ آره، فعال شو", callback_data: `approve:${chatId}` },
      { text: "❌ نه", callback_data: `deny:${chatId}` },
    ],
  ],
});

/**
 * Authorization gate for an incoming message. Private → admin only. Group/
 * supergroup → only when that chat has been approved. Anything else (channels)
 * is not served.
 *
 * @param {object} message  Telegram `message` object.
 * @returns {Promise<boolean>}
 */
const isMessageAuthorized = async (message) => {
  const type = message?.chat?.type;
  if (type === "private") return isAdmin(message.from?.id);
  if (type === "group" || type === "supergroup") {
    const access = await getChatAccess(message.chat.id);
    return access?.status === "approved";
  }
  return false;
};

/**
 * Handle a `my_chat_member` update — the bot's own membership changing. When the
 * bot is freshly added to a group we mark it pending and DM the admin to confirm
 * (unless it's already approved). When removed, we mark it removed.
 *
 * @param {object} myChatMember  Telegram `my_chat_member` update.
 */
const handleMembershipChange = async (myChatMember) => {
  const chat = myChatMember?.chat;
  if (chat?.type !== "group" && chat?.type !== "supergroup") return;

  const status = myChatMember?.new_chat_member?.status;
  const added = status === "member" || status === "administrator";
  const removed = status === "left" || status === "kicked";

  if (added) {
    const existing = await getChatAccess(chat.id);
    if (existing?.status === "approved") return; // re-added to a known group.
    await setChatAccess(chat.id, "pending", chat.title);
    await sendMessage(
      process.env.ADMIN_USER_ID,
      ASK_APPROVAL(chat.title ?? chat.id),
      undefined,
      approvalKeyboard(chat.id)
    );
  } else if (removed) {
    await setChatAccess(chat.id, "removed", chat.title);
  }
};

/**
 * Handle a tapped approve/deny button. Only the admin may act; the chosen status
 * is written and the admin gets a toast. On approval the group is greeted.
 *
 * @param {object} callbackQuery  Telegram `callback_query` update.
 */
const handleCallbackQuery = async (callbackQuery) => {
  if (!isAdmin(callbackQuery?.from?.id)) {
    await answerCallbackQuery(callbackQuery.id, CB_NOT_ADMIN);
    return;
  }

  const [action, chatId] = String(callbackQuery.data ?? "").split(":");
  if (!chatId) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (action === "approve") {
    await setChatAccess(chatId, "approved");
    await answerCallbackQuery(callbackQuery.id, CB_APPROVED);
    try {
      await sendMessage(chatId, GROUP_APPROVED);
    } catch (err) {
      console.error("Failed to greet approved group:", err?.message);
    }
  } else {
    await setChatAccess(chatId, "denied");
    await answerCallbackQuery(callbackQuery.id, CB_DENIED);
  }
};

// Pre-written Persian lines for the admin slash-command fallback.
const CMD_APPROVED = "فعال شد ✅ از این به بعد اینجا هستم.";
const CMD_DENIED = "باشه، اینجا ساکت می‌مونم.";
const CMD_NEED_ID = "از داخل خود گروه بزن، یا: /approve <chat_id>";

// Human-readable Persian label for a chat's access status, for the admin's
// `/groups` overview. Code-owned: the statuses are the same allowlist values
// setChatAccess writes (pending | approved | denied | removed).
const STATUS_LABEL = {
  approved: "فعال ✅",
  pending: "در انتظار تأیید ⏳",
  denied: "ردشده ❌",
  removed: "حذف‌شده 🚪",
};
export const statusLabel = (status) =>
  STATUS_LABEL[status] ?? `${status ?? "نامعلوم"} ❓`;

// The admin command set, registered with Telegram (setMyCommands) so the «/»
// menu lists and autocompletes them natively. Descriptions are Persian, shown in
// the client. Scoped to the admin's private chat so only the admin sees them.
export const ADMIN_COMMANDS = [
  { command: "groups", description: "گروه‌ها و وضعیت تأییدشون" },
  { command: "usage", description: "وضعیت اعتبار و خرجِ این ماه" },
  { command: "approve", description: "فعال‌کردن گروه (داخل گروه، یا با chat_id)" },
  { command: "deny", description: "ساکت‌کردن گروه (داخل گروه، یا با chat_id)" },
  { command: "help", description: "راهنمای دستورها" },
];

// Persian help text listing what the admin can do. Mirrors ADMIN_COMMANDS plus
// the debug flag, which is intentionally not a registered command.
export const ADMIN_HELP = [
  "دستورهای مدیریتی فضول‌خان:",
  "/groups — لیست گروه‌ها و وضعیتشون، با دکمه‌ی تغییر",
  "/usage — خرج این ماه، باقی‌مونده و تاریخ ریست",
  "/approve — فعال‌کردن گروه (داخل گروه بزن، یا تو دایرکت: /approve <chat_id>)",
  "/deny — ساکت‌کردن گروه (مثل بالا)",
  "",
  "حالت دیباگ: هر وقت توی پیامت که منو صدا می‌زنی «#debug» بذاری، به‌جای جواب عادی،",
  "همه‌ی دیتای خونده‌شده از دیتابیس، پرامپت‌ها و خروجی مدل (هم جواب هم خلاصه) رو",
  "برات می‌فرستم. تو این حالت خلاصه ذخیره نمی‌شه و چیزی یاد نمی‌گیرم — فقط تست.",
].join("\n");

// Registering the command menu is idempotent but a network call, so do it at
// most once per warm Lambda container. Flipped after the first successful call.
let commandsRegistered = false;

/**
 * Ensure the native command menu is registered for the admin's DM. Idempotent and
 * cheap after the first call in a container. Best-effort: a failure never blocks
 * the command the admin actually ran.
 */
const ensureAdminCommands = async () => {
  if (commandsRegistered || !process.env.ADMIN_USER_ID) return;
  try {
    await setMyCommands(ADMIN_COMMANDS, {
      type: "chat",
      chat_id: Number(process.env.ADMIN_USER_ID),
    });
    commandsRegistered = true;
  } catch (err) {
    console.error("Failed to register admin commands:", err?.message);
  }
};

const NO_GROUPS = "هنوز تو هیچ گروهی نیستم 🤷";
const GROUPS_HEADER = "گروه‌هایی که منو اضافه کردن:";
const GROUPS_FOOTER = "برای تغییر وضعیت، دکمه‌ی هر گروه رو بزن:";

// One alter-row per group for the `/groups` overview: tapping reuses the same
// approve/deny callbacks the membership flow already handles. The group's title
// (truncated) rides on the approve button so the admin can tell rows apart.
export const groupsKeyboard = (chats) => ({
  inline_keyboard: chats.map((c) => {
    const title = (c.title ?? String(c.chatId)).slice(0, 24);
    return [
      { text: `✅ ${title}`, callback_data: `approve:${c.chatId}` },
      { text: "❌", callback_data: `deny:${c.chatId}` },
    ];
  }),
});

/**
 * Render the admin `/groups` overview: every chat the bot has been added to, with
 * its current approval status, plus inline buttons to flip each one. Pure
 * formatting over the code-owned access records — no Bedrock, no LLM.
 *
 * @param {Array<{chatId: number|string, status: string, title?: string}>} chats
 * @returns {{text: string, replyMarkup?: object}}
 */
export const renderGroups = (chats) => {
  if (!chats.length) return { text: NO_GROUPS };
  const lines = chats.map(
    (c) => `• «${c.title ?? c.chatId}» — ${statusLabel(c.status)}`
  );
  return {
    text: `${GROUPS_HEADER}\n\n${lines.join("\n")}\n\n${GROUPS_FOOTER}`,
    replyMarkup: groupsKeyboard(chats),
  };
};

// First day of next month (UTC) as YYYY-MM-DD — when the monthly spend counter
// rolls over to a fresh BUDGET item and the budget effectively resets.
export const monthlyResetDate = () => {
  const [year, month] = currentMonth().split("-").map(Number);
  // month is 1-based; Date's month arg is 0-based, so `month` is next month.
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
};

/**
 * Render the admin credit-usage summary for the current month: spent so far, the
 * ceiling, what's left, and when it resets. Pure formatting over the code-owned
 * spend counter — no Bedrock.
 *
 * @param {number} spent  Euros spent this month.
 * @param {number} budget  The monthly ceiling in euros.
 * @returns {string}
 */
export const renderUsage = (spent, budget) => {
  const remaining = Math.max(0, budget - spent);
  const overBudget = spent >= budget;
  return [
    `وضعیت اعتبار (ماه ${currentMonth()}):`,
    `• خرج‌شده: ${spent.toFixed(2)} یورو`,
    `• سقف ماهانه: ${budget.toFixed(2)} یورو`,
    `• باقی‌مونده: ${remaining.toFixed(2)} یورو`,
    `• ریست: ${monthlyResetDate()} (اول ماه بعد)`,
    overBudget ? "\nاین ماه ته کشید 😅 تا ریست مهمونِ سکوتم‌این." : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * Parse a slash-command, tolerating Telegram's `/cmd@botname` form and an
 * optional argument. Returns null if the text isn't a command.
 *
 * @param {string} text  Message text or caption.
 * @returns {{cmd: string, arg: string}|null}
 */
export const parseCommand = (text) => {
  const m = String(text ?? "")
    .trim()
    .match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[2] ?? "").trim() };
};

/**
 * Admin slash-command fallback for the button flow — reliable even if the
 * `my_chat_member` approval DM was never delivered (e.g. webhook misconfigured
 * at add-time). Only the admin acts. In a group `/approve` and `/deny` target
 * the current chat; from a DM they take an explicit `<chat_id>` argument. This
 * runs before the access gate so it works in a not-yet-approved group.
 *
 * @param {object} message  Telegram `message` object.
 * @returns {Promise<boolean>} True if the message was an admin command we acted on.
 */
const handleAdminCommand = async (message) => {
  if (!isAdmin(message?.from?.id)) return false;
  const parsed = parseCommand(message.text ?? message.caption);
  if (!parsed) return false;

  // First admin command in this container also registers the native menu, so the
  // «/» autocomplete populates without the admin having to run /start first.
  await ensureAdminCommands();

  // /start or /help: reply with the help text (the menu is already registered
  // above). /start is Telegram's conventional first command for any bot.
  if (parsed.cmd === "start" || parsed.cmd === "help") {
    await sendMessage(message.chat.id, ADMIN_HELP, message.message_id);
    return true;
  }

  // Read-only admin overviews: the group list (with alter buttons) and the
  // monthly credit usage. No Bedrock — pure reads over code-owned state.
  if (parsed.cmd === "groups") {
    const { text, replyMarkup } = renderGroups(await listChatAccess());
    await sendMessage(message.chat.id, text, message.message_id, replyMarkup);
    return true;
  }
  if (parsed.cmd === "usage" || parsed.cmd === "credit") {
    const budget = Number(process.env.MONTHLY_BUDGET_EUR ?? 5);
    const spent = await getMonthlySpend();
    await sendMessage(
      message.chat.id,
      renderUsage(spent, budget),
      message.message_id
    );
    return true;
  }

  if (parsed.cmd !== "approve" && parsed.cmd !== "deny") {
    return false;
  }

  const type = message.chat?.type;
  const inGroup = type === "group" || type === "supergroup";
  const targetId = inGroup ? message.chat.id : parsed.arg;
  const title = inGroup ? message.chat.title : undefined;

  if (!targetId) {
    await sendMessage(message.chat.id, CMD_NEED_ID, message.message_id);
    return true;
  }

  const status = parsed.cmd === "approve" ? "approved" : "denied";
  await setChatAccess(targetId, status, title);
  await sendMessage(
    message.chat.id,
    status === "approved" ? CMD_APPROVED : CMD_DENIED,
    message.message_id
  );

  // Approving from a DM by id: greet the target group too.
  if (status === "approved" && String(targetId) !== String(message.chat.id)) {
    try {
      await sendMessage(targetId, GROUP_APPROVED);
    } catch (err) {
      console.error("Failed to greet approved group:", err?.message);
    }
  }
  return true;
};

/**
 * Decide whether the bot should respond to a message. In a private chat (only
 * reachable by the admin past the access gate) every message is answered. In
 * groups, true only when the bot was @-mentioned by username, or the message is
 * a reply to one of the bot's own messages. Everything else is ignored.
 *
 * @param {object} message  Telegram `message` object.
 * @param {string} botUsername  The bot's @username (without the leading @).
 */
export const shouldRespond = (message, botUsername) => {
  if (!message || !botUsername) return false;

  // Private chats are admin-only by the time we get here, so answer directly —
  // no @-mention needed when you're DMing your own bot.
  if (message.chat?.type === "private") return true;

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
 * Build the context for the message the trigger is a reply to, so the bot
 * comments on the *referenced* post rather than only on its own mention. Returns
 * undefined when the trigger isn't a reply or the replied-to message has no text.
 * The bot's own messages are flagged `self` so the transcript marks them.
 *
 * @param {object} message  Telegram `message` object.
 * @param {string} botUsername  The bot's @username (without @).
 * @returns {{name: string, text: string, self: boolean}|undefined}
 */
export const replyContextOf = (message, botUsername) => {
  const replied = message?.reply_to_message;
  const text = (replied?.text ?? replied?.caption ?? "").trim();
  if (!text) return undefined;

  const self = replied.from?.username === botUsername;
  const name = self
    ? "فضول‌خان"
    : [replied.from?.first_name, replied.from?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || "یه نفر";
  return { name, text, self };
};

// -----------------------------------------------------------------------------
// DEBUG MODE (admin only). When the admin includes `#debug` in the message that
// addresses the bot, the bot runs the real pipeline but, instead of replying,
// returns a full dump: the data read from the DB, the exact system/user prompts,
// and the model output for both the reply and a *dry-run* summary that is NOT
// persisted. It's a testing harness — nothing is learned or saved (the spend
// counter is still incremented, since real Bedrock calls really happened).
// -----------------------------------------------------------------------------

// The marker the admin appends to turn a normal mention into a debug run. Matched
// as a standalone token so it never trips on substrings.
export const DEBUG_FLAG = /(^|\s)#debug(\s|$)/i;

// True only for an admin message carrying the debug marker.
export const wantsDebug = (message) =>
  isAdmin(message?.from?.id) &&
  DEBUG_FLAG.test(message?.text ?? message?.caption ?? "");

// Telegram caps a single message near 4096 chars; debug dumps can exceed that, so
// split into chunks well under the limit. Only the first chunk threads under the
// trigger, to keep the rest readable as a sequence.
export const TELEGRAM_CHUNK = 3800;
export const sendChunked = async (chatId, text, replyToMessageId) => {
  for (let i = 0; i < text.length; i += TELEGRAM_CHUNK) {
    await sendMessage(
      chatId,
      text.slice(i, i + TELEGRAM_CHUNK),
      i === 0 ? replyToMessageId : undefined
    );
  }
};

// Render one recent-buffer line the way the model sees it, for the dump.
export const debugLine = (m) =>
  m?.self ? `فضول‌خان (خود بات): ${m.text}` : `${m?.name ?? "یه نفر"}: ${m?.text}`;

/**
 * Run the admin debug pipeline: generate the reply (real Bedrock call) and a
 * dry-run summary for the speaker, then dump every input and output. Saves
 * nothing — not the observations, not the summary. The real call costs are still
 * added to the monthly counter (honest accounting; the spend guard already let
 * us through above).
 *
 * @param {object} args
 * @param {object} args.message  The triggering Telegram message.
 * @param {object|null} args.speaker  The speaker's PROFILE item.
 * @param {object|null} args.resolution  Name-resolution outcome for the message.
 * @param {Array|null} args.recentMessages  The rolling context buffer.
 * @param {object} [args.replyTo]  The replied-to message context, if any.
 * @param {string} args.profileSnippet  The snippet that would be sent to the model.
 * @param {string} args.nameNote  The ambiguity note, if any.
 */
const runDebug = async ({
  message,
  speaker,
  resolution,
  recentMessages,
  replyTo,
  profileSnippet,
  nameNote,
}) => {
  const speakerId = message.from?.id;
  const sections = ["🐞 حالت دیباگ — هیچی ذخیره نمی‌شه\n"];

  // 1) What we read from the DB / system before any model call.
  const spent = await getMonthlySpend();
  const existingObs = speakerId ? await getObservations(speakerId) : [];
  sections.push(
    [
      "== ورودی (از دیتابیس و سیستم) ==",
      `چت: type=${message.chat?.type} id=${message.chat?.id}`,
      `گوینده: id=${speakerId} | نام‌ها=${(speaker?.names_seen ?? []).join(", ") || "—"}`,
      `خلاصه‌ی فعلیِ گوینده: ${speaker?.summary || "—"}`,
      `name resolution: ${resolution ? JSON.stringify(resolution) : "—"}`,
      `nameNote: ${nameNote || "—"}`,
      `profileSnippet (که به مدل می‌ره): ${profileSnippet || "—"}`,
      `خرج این ماه: ${spent.toFixed(4)} از ${Number(
        process.env.MONTHLY_BUDGET_EUR ?? 5
      ).toFixed(2)} یورو`,
      "",
      "گفتگوی اخیر (بافر):",
      ...(recentMessages?.length ? recentMessages.map(debugLine) : ["—"]),
      "",
      `ریپلای‌به: ${replyTo ? debugLine(replyTo) : "—"}`,
      `OBS فعلیِ گوینده (${existingObs.length}): ${
        existingObs.length ? existingObs.join(" | ") : "—"
      }`,
    ].join("\n")
  );

  // 2) The reply call: exact prompts in, raw output out.
  const reply = await generateReply({
    recentMessages,
    replyTo,
    profileSnippet,
    nameNote,
  });
  await addMonthlySpend(reply.costEur); // honest accounting: the call happened.
  sections.push(
    [
      "== فراخوانِ جواب (REPLY) ==",
      "--- system prompt ---",
      reply.systemPrompt,
      "",
      "--- user prompt ---",
      reply.userPrompt,
      "",
      "--- خروجی خام مدل ---",
      reply.raw || "—",
      "",
      `جوابِ تمیزشده: ${reply.text || "—"}`,
      `observations (parse‌شده): ${
        reply.observations.length
          ? reply.observations
              .map((o) => `${o.name} → ${o.note}`)
              .join(" | ")
          : "—"
      }`,
      `هزینه: ${reply.costEur.toFixed(5)} یورو`,
    ].join("\n")
  );

  // 3) The summary call — a DRY RUN for the speaker, mirroring maybeSummarize but
  // never persisted. Build the same input it would get: the speaker's existing
  // observations plus any note from this turn that resolves to the speaker.
  const newNotesAboutSpeaker = [];
  for (const { name, note } of reply.observations) {
    const targetId = await resolveObservationTarget(
      message.from,
      name,
      process.env.BOT_USERNAME
    );
    if (String(targetId) === String(speakerId)) newNotesAboutSpeaker.push(note);
  }
  const summaryInput = [...existingObs, ...newNotesAboutSpeaker];

  if (summaryInput.length) {
    const sum = await summarizeObservations({
      summary: speaker?.summary,
      observations: summaryInput,
    });
    await addMonthlySpend(sum.costEur); // the call happened — count it.
    sections.push(
      [
        "== فراخوانِ خلاصه (SUMMARY — dry-run، ذخیره نشد) ==",
        `هدف: گوینده id=${speakerId}`,
        "--- system prompt ---",
        sum.systemPrompt,
        "",
        "--- user prompt ---",
        sum.userPrompt,
        "",
        "--- خلاصه‌ی جدید (ذخیره نمی‌شه) ---",
        sum.summary || "—",
        `هزینه: ${sum.costEur.toFixed(5)} یورو`,
      ].join("\n")
    );
  } else {
    sections.push(
      "== فراخوانِ خلاصه ==\nنکته‌ای برای خلاصه‌کردنِ گوینده نبود؛ این مرحله رد شد."
    );
  }

  await sendChunked(message.chat.id, sections.join("\n\n"), message.message_id);
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

  // ACCESS CONTROL routing (before any work). The bot's own membership changing
  // drives the approval flow; tapped approve/deny buttons resolve it. Both are
  // delivered by Telegram's default webhook update set.
  try {
    if (update?.my_chat_member) {
      await handleMembershipChange(update.my_chat_member);
      return ok;
    }
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return ok;
    }
  } catch (err) {
    console.error("Access-control routing failed:", err?.message);
    return ok;
  }

  // Only plain messages can mention or reply to the bot. Edited messages and
  // other update kinds are ignored.
  const message = update?.message;
  const messageText = message?.text ?? message?.caption ?? "";

  // Admin slash-command fallback (/approve, /deny). Runs before the gate so the
  // admin can approve a not-yet-approved group from inside it.
  try {
    if (message && (await handleAdminCommand(message))) return ok;
  } catch (err) {
    console.error("Admin command failed:", err?.message);
    return ok;
  }

  // ACCESS GATE: unauthorized senders (non-admin DMs, unapproved groups) get no
  // work at all — no recording, no learning, no Bedrock. Stay silent but ack.
  if (!message || !(await isMessageAuthorized(message))) {
    return ok;
  }

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

  // Code-owned learning: every visible message teaches the name->person map and
  // the who-talks-to-whom edges (sender's own name, reply targets, text-mentions).
  // Runs for all traffic, not only when addressed, so weights improve over time.
  if (message) {
    try {
      await learnFromMessage(message);
    } catch (err) {
      console.error("Failed to learn name/edge weights:", err?.message);
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
  // user_id). By default the snippet describes the speaker so the bot knows who
  // it's replying to. Then run name resolution: if the speaker is asking about
  // someone by name, swap in that person's profile when we're confident, or hand
  // the LLM an ambiguity note so the "which one?" becomes the joke.
  let profileSnippet = "";
  let nameNote = "";
  let speaker = null; // kept for the debug dump (the speaker's full profile).
  let resolution = null; // kept for the debug dump (name-resolution outcome).
  try {
    speaker = await recordSighting(message.from);
    profileSnippet = snippetOf(speaker);

    resolution = await resolveName(
      message.from?.id,
      messageText,
      process.env.BOT_USERNAME
    );
    if (
      resolution.status === "confident" &&
      resolution.userId !== message.from?.id
    ) {
      const subject = await getProfile(resolution.userId);
      if (subject) profileSnippet = snippetOf(subject);
    } else if (resolution.status === "ambiguous") {
      nameNote = await describeAmbiguity(resolution);
    }
  } catch (err) {
    console.error("Failed to resolve/read profile:", err?.message);
  }

  // The message being replied to (if any), so the bot comments on the referenced
  // post — not just on its own mention.
  const replyTo = replyContextOf(message, process.env.BOT_USERNAME);

  // DEBUG MODE (admin only): if the admin put `#debug` in the triggering message,
  // run the same pipeline but, instead of replying, dump everything — the data
  // read from the DB, the exact prompts, and the model output for both the reply
  // and the (dry-run) summary. Nothing is saved (the summary in particular), so
  // it's a safe testing harness. The spend guard above still applies; the real
  // Bedrock calls are still counted (honest accounting — see AGENTS.md).
  if (wantsDebug(message)) {
    try {
      await runDebug({
        message,
        speaker,
        resolution,
        recentMessages,
        replyTo,
        profileSnippet,
        nameNote,
      });
    } catch (err) {
      console.error("Debug run failed:", err?.message);
      try {
        await sendMessage(
          message.chat.id,
          `دیباگ خطا خورد: ${err?.message ?? err}`,
          message.message_id
        );
      } catch {}
    }
    return ok;
  }

  // Generate an in-character Persian reply from the assembled context and send
  // it back, threaded under the triggering message. Errors are swallowed so
  // Telegram does not retry.
  try {
    const { text, observations, costEur } = await generateReply({
      recentMessages,
      replyTo,
      profileSnippet,
      nameNote,
    });
    // Increment the monthly spend counter after every successful call (the
    // estimated euro cost from the call's token usage).
    await addMonthlySpend(costEur);
    if (text) {
      await sendMessage(message.chat.id, text, message.message_id);
      // Record our own reply into the rolling buffer so next turn the bot sees
      // what it already said. Best-effort: never let it look like a failed reply.
      try {
        await recordBotMessage(message.chat.id, text);
      } catch (err) {
        console.error("Failed to record bot message:", err?.message);
      }
    }

    // Side effect: remember the LLM's tagged observations (about the speaker and
    // any third parties named in the chat) and, occasionally, fold them into a
    // profile summary. Kept in its own try so a memory hiccup never looks like a
    // failed reply.
    try {
      await rememberObservations(message.from, observations, monthlyBudget);
    } catch (err) {
      console.error("Failed to record observation/summary:", err?.message);
    }
  } catch (err) {
    console.error("Failed to generate/send reply:", err?.message);
  }

  return ok;
};
