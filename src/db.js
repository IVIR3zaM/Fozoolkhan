// DynamoDB access for فضول‌خان (Fozoolkhan).
//
// Milestone 3: write and read a `USER#<uid> / PROFILE` item.
// Milestone 5: keep a small rolling per-chat buffer of the most recent messages
// (`CHAT#<chatId> / RECENT`) so we can assemble tight context without ever
// sending full history to the model.
// Milestone 7: the name->person map (`NAME#<name> / USER#<uid>` with a `weight`)
// and the who-talks-to-whom edges (`EDGE#<uid_a> / USER#<uid_b>` with a `count`).
// These are pure structure — incremented by code from real addressing signals,
// never written by the LLM.
// Milestone 8: the append-only observation log (`USER#<uid> / OBS#<ts>`, each
// item TTL-expiring) and a code-owned write of *only* the free-text `summary`
// field. The LLM contributes prose (one-line observations, and the compressed
// summary via the separate summarization step); code still owns every structure
// around it and decides which field that prose may land in.
//
// Code owns all structure here. Everything is anchored to the numeric Telegram
// `user_id` — never the username or display name, which are mutable labels. The
// LLM never touches these items directly (later milestones append OBS# lines and
// summarize into the free-text `summary` field; that is the only LLM-written
// field).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// One shared client per Lambda container. The table name comes from the
// environment so the same code runs against different tables (dev/prod).
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = () => process.env.DDB_TABLE_NAME;

// Primary key for a person's profile item. Anchored to the numeric user id.
const profileKey = (userId) => ({ PK: `USER#${userId}`, SK: "PROFILE" });

// Primary key for a chat's rolling recent-messages buffer.
const recentKey = (chatId) => ({ PK: `CHAT#${chatId}`, SK: "RECENT" });

// Primary key for the running monthly spend counter. Keyed by month so it
// resets naturally at month rollover (no cron, no cleanup).
const budgetKey = (month) => ({ PK: "BUDGET", SK: `MONTH#${month}` });

// Primary key for a chat's access record. Code-owned allowlist: a group is inert
// until the admin approves it. `status` is one of pending | approved | denied |
// removed (see ACCESS CONTROL in index.js). Anchored to the numeric chat id.
const chatAccessKey = (chatId) => ({ PK: `CHAT#${chatId}`, SK: "ACCESS" });

// The current month as `YYYY-MM` (UTC), matching the BUDGET item's SK.
export const currentMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Normalize a spoken name into a stable key so the same name always points at
 * the same `NAME#` partition. Code-owned: trims, lowercases, drops a leading
 * `@`, folds common Arabic letter forms to their Persian equivalents (so e.g.
 * Arabic and Persian yeh/kaf key together), and strips surrounding punctuation.
 *
 * @param {string} raw  Raw spoken name or token.
 * @returns {string} Normalized key (may be empty).
 */
export const normalizeName = (raw) => {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^@+/, "");
  s = s.replace(/[يى]/g, "ی").replace(/ك/g, "ک"); // Arabic -> Persian.
  s = s.replace(/[«»"'`،؛؟.!?,:()[\]{}…]/g, "");
  return s.trim();
};

// Primary keys for the name->person map and the who-talks-to-whom edges. Both
// are anchored to the numeric user id; the name is only a label that points at
// an id (see ARCHITECTURE.md).
const nameKey = (name, userId) => ({
  PK: `NAME#${normalizeName(name)}`,
  SK: `USER#${userId}`,
});
const edgeKey = (askerId, userId) => ({
  PK: `EDGE#${askerId}`,
  SK: `USER#${userId}`,
});

// Primary key for the username->person index. A Telegram @username uniquely
// identifies one account, so unlike NAME# (many candidates per spoken name) this
// is a clean 1:1 map. Code-owned: it lets edge learning turn a bare `@username`
// mention into an edge to the right numeric id.
const usernameKey = (username) => ({
  PK: `USERNAME#${normalizeName(username)}`,
  SK: "OWNER",
});

// Primary key for one append-only observation about a person, sorted by ISO
// timestamp under that person's partition.
const obsKey = (userId, ts) => ({ PK: `USER#${userId}`, SK: `OBS#${ts}` });

// How many days an observation lives before DynamoDB TTL auto-expires it, so the
// log (and the summarization input it feeds) stays small. Token frugality.
const obsTtlDays = () => Number(process.env.OBS_TTL_DAYS ?? 30);

// How many recent messages to keep (and later send as context). Never full
// history — token frugality is a hard rule (see AGENTS.md).
const contextMessageCount = () =>
  Number(process.env.CONTEXT_MESSAGE_COUNT ?? 5);

// The display name we show for a person in context, derived in code from the
// Telegram `from` object (a label only — identity is the numeric id elsewhere).
const displayNameOf = (from) =>
  [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim();

/**
 * Read a person's PROFILE item by numeric user id.
 *
 * @param {number|string} userId  Numeric Telegram user id.
 * @returns {Promise<object|null>} The profile item, or null if none exists.
 */
export const getProfile = async (userId) => {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: profileKey(userId) }),
  );
  return Item ?? null;
};

/**
 * Record that we have seen this person, merging their current display name and
 * username into the PROFILE item. This is a code-owned, read-modify-write upsert
 * (structure only — it never writes free-text the LLM should own).
 *
 * @param {object} from  Telegram `message.from` object.
 * @returns {Promise<object>} The stored profile item.
 */
export const recordSighting = async (from) => {
  if (!from?.id) throw new Error("recordSighting: from.id is required");

  const existing = (await getProfile(from.id)) ?? {
    ...profileKey(from.id),
    user_id: from.id,
    names_seen: [],
    usernames_seen: [],
    summary: "", // free-text; owned by the LLM via later summarization step.
  };

  // Names/usernames are sets-of-strings kept deduplicated in code.
  const displayName = displayNameOf(from);
  const names = new Set(existing.names_seen ?? []);
  if (displayName) names.add(displayName);
  const usernames = new Set(existing.usernames_seen ?? []);
  if (from.username) usernames.add(from.username);

  const item = {
    ...existing,
    user_id: from.id,
    names_seen: [...names],
    usernames_seen: [...usernames],
    last_updated: new Date().toISOString(),
  };

  await docClient.send(new PutCommand({ TableName: tableName(), Item: item }));
  return item;
};

/**
 * Append one entry to a chat's rolling recent-messages buffer and trim it to the
 * last `CONTEXT_MESSAGE_COUNT` entries. Code-owned structure: each entry holds a
 * name label, the raw text, and an optional `self` flag (the bot's own lines), so
 * context assembly never has to send full history. Shared by recordMessage (an
 * incoming message) and recordBotMessage (the bot's own reply).
 *
 * @param {number|string} chatId  Telegram chat id.
 * @param {{name: string, text: string, self?: boolean}} entry
 * @returns {Promise<Array<{name: string, text: string, self?: boolean}>>}
 */
const appendRecent = async (chatId, entry) => {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: recentKey(chatId) }),
  );

  const messages = Item?.messages ?? [];
  messages.push(entry);
  const recent = messages.slice(-contextMessageCount());

  await docClient.send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...recentKey(chatId), messages: recent },
    }),
  );

  return recent;
};

/**
 * Append an incoming message to a chat's rolling recent-messages buffer.
 *
 * @param {number|string} chatId  Telegram chat id.
 * @param {object} from  Telegram `message.from` object.
 * @param {string} text  Message text (or caption).
 * @returns {Promise<Array<{name: string, text: string}>|null>} The trimmed
 *   buffer (newest last), or null if there was nothing worth remembering.
 */
export const recordMessage = async (chatId, from, text) => {
  if (!chatId) throw new Error("recordMessage: chatId is required");

  const trimmed = (text ?? "").trim();
  if (!trimmed) return null; // media-only or empty — nothing to remember.

  return appendRecent(chatId, {
    name: displayNameOf(from) || "یه نفر",
    text: trimmed,
  });
};

/**
 * Append the bot's own reply to the recent buffer, flagged `self` so next turn
 * the model sees what it already said (and doesn't repeat itself or mistake its
 * own lines for someone else's). Telegram never delivers the bot's own messages
 * back as webhook updates, so without this the bot is blind to its own turns.
 *
 * @param {number|string} chatId  Telegram chat id.
 * @param {string} text  The reply text the bot just sent.
 */
export const recordBotMessage = async (chatId, text) => {
  if (!chatId) return;
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  await appendRecent(chatId, { name: "فضول‌خان", text: trimmed, self: true });
};

/**
 * Read a chat's access record, or null if we've never seen this chat. Code-owned
 * allowlist state — the gate the handler reads before doing any work for a group.
 *
 * @param {number|string} chatId  Numeric Telegram chat id.
 * @returns {Promise<object|null>} The access item, or null if none exists.
 */
export const getChatAccess = async (chatId) => {
  if (!chatId) return null;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: chatAccessKey(chatId) }),
  );
  return Item ?? null;
};

/**
 * Set a chat's access status (and optionally its title). Code-owned, structure
 * only: an Update so flipping the status never wipes a previously stored title.
 * `status` is reserved in DynamoDB, hence the `#s` alias.
 *
 * @param {number|string} chatId  Numeric Telegram chat id.
 * @param {string} status  pending | approved | denied | removed.
 * @param {string} [title]  The chat's title, stored for the admin's prompt.
 */
export const setChatAccess = async (chatId, status, title) => {
  if (!chatId || !status) return;
  const names = { "#s": "status" };
  const values = { ":s": status, ":t": new Date().toISOString() };
  let expr = "SET #s = :s, last_updated = :t";
  if (title) {
    names["#title"] = "title";
    values[":title"] = title;
    expr += ", #title = :title";
  }
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: chatAccessKey(chatId),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
};

/**
 * List every chat access record we hold (one per group the bot has ever been
 * added to), newest activity first. Code-owned admin read: the table is tiny and
 * reconstructable, so a filtered Scan for the `ACCESS` items is cheap and avoids
 * needing a secondary index. Used by the admin `/groups` overview.
 *
 * @returns {Promise<Array<{chatId: number|string, status: string,
 *   title?: string, last_updated?: string}>>}
 */
export const listChatAccess = async () => {
  const items = [];
  let startKey;
  do {
    const { Items, LastEvaluatedKey } = await docClient.send(
      new ScanCommand({
        TableName: tableName(),
        FilterExpression: "SK = :access",
        ExpressionAttributeValues: { ":access": "ACCESS" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const i of Items ?? []) {
      items.push({
        chatId: String(i.PK ?? "").replace(/^CHAT#/, ""),
        status: i.status,
        title: i.title,
        last_updated: i.last_updated,
      });
    }
    startKey = LastEvaluatedKey;
  } while (startKey);

  // Most recently touched first, so the admin sees fresh activity at the top.
  items.sort((a, b) =>
    String(b.last_updated ?? "").localeCompare(a.last_updated ?? ""),
  );
  return items;
};

/**
 * Read the running spend estimate (in euros) for a month. Code-owned: this is
 * the brake the spend guard reads before every Bedrock call. Defaults to 0 when
 * the month has no item yet.
 *
 * @param {string} [month]  `YYYY-MM`; defaults to the current month.
 * @returns {Promise<number>} Euros spent so far this month.
 */
export const getMonthlySpend = async (month = currentMonth()) => {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: budgetKey(month) }),
  );
  return Number(Item?.spend_eur ?? 0);
};

/**
 * Atomically add to the month's spend estimate after a successful Bedrock call.
 * Uses a DynamoDB `ADD` so concurrent Lambda invocations can't clobber each
 * other. Never called when the guard has blocked a call (nothing was spent).
 *
 * @param {number} amountEur  Estimated euro cost of the call (must be > 0).
 * @param {string} [month]  `YYYY-MM`; defaults to the current month.
 */
export const addMonthlySpend = async (amountEur, month = currentMonth()) => {
  if (!(amountEur > 0)) return;
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: budgetKey(month),
      UpdateExpression: "ADD spend_eur :amt",
      ExpressionAttributeValues: { ":amt": amountEur },
    }),
  );
};

/**
 * Increment the weight that a spoken `name` refers to `userId`. Code-owned: the
 * caller derives the (name, id) pair from a real addressing signal (a person's
 * own name, a reply target, an explicit text-mention). No-op for blank names.
 *
 * @param {string} name  Spoken name/label.
 * @param {number|string} userId  Numeric user id the name points at.
 * @param {number} [amount]  Increment (default 1).
 */
export const bumpNameWeight = async (name, userId, amount = 1) => {
  const key = normalizeName(name);
  if (!key || !userId) return;
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: nameKey(name, userId),
      UpdateExpression: "ADD weight :n SET user_id = :u",
      ExpressionAttributeValues: { ":n": amount, ":u": userId },
    }),
  );
};

/**
 * Increment the interaction count for the edge asker -> userId (how often the
 * asker addresses/replies to that person). Code-owned, structure only.
 *
 * @param {number|string} askerId  Who is addressing.
 * @param {number|string} userId  Who is being addressed.
 * @param {number} [amount]  Increment (default 1).
 */
export const bumpEdge = async (askerId, userId, amount = 1) => {
  if (!askerId || !userId) return;
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: edgeKey(askerId, userId),
      UpdateExpression: "ADD #c :n",
      ExpressionAttributeNames: { "#c": "count" },
      ExpressionAttributeValues: { ":n": amount },
    }),
  );
};

/**
 * List all candidate people a spoken name could refer to, with their weights.
 *
 * @param {string} name  Spoken name/label.
 * @returns {Promise<Array<{userId: number|string, weight: number}>>}
 */
export const getNameCandidates = async (name) => {
  const key = normalizeName(name);
  if (!key) return [];
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `NAME#${key}` },
    }),
  );
  return (Items ?? []).map((i) => ({
    userId: i.user_id,
    weight: Number(i.weight ?? 0),
  }));
};

/**
 * Record that an @username currently belongs to a numeric user id. Code-owned,
 * structure only: latest write wins, so if a username changes hands the index
 * follows. No-op for blank usernames. This is what lets a later `@username`
 * mention be resolved to an id for edge learning.
 *
 * @param {string} username  The @username (with or without the leading @).
 * @param {number|string} userId  Numeric user id that owns it.
 */
export const recordUsername = async (username, userId) => {
  const key = normalizeName(username);
  if (!key || !userId) return;
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: usernameKey(username),
      UpdateExpression: "SET user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
    }),
  );
};

/**
 * Resolve an @username to the numeric user id that owns it, or null if we have
 * never seen that username speak. Self-improving: coverage grows as people post.
 *
 * @param {string} username  The @username (with or without the leading @).
 * @returns {Promise<number|string|null>}
 */
export const resolveUsername = async (username) => {
  const key = normalizeName(username);
  if (!key) return null;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: usernameKey(username) }),
  );
  return Item?.user_id ?? null;
};

/**
 * Read the interaction count for the edge asker -> userId (0 if none yet).
 *
 * @param {number|string} askerId  Who is addressing.
 * @param {number|string} userId  Who is being addressed.
 * @returns {Promise<number>}
 */
export const getEdgeCount = async (askerId, userId) => {
  if (!askerId || !userId) return 0;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: edgeKey(askerId, userId) }),
  );
  return Number(Item?.count ?? 0);
};

/**
 * Append a one-line observation about a person to their append-only OBS# log.
 * This is the only free-text the LLM contributes here, and it lands in its own
 * item — never in a structured field. Each item carries a `ttl` (epoch seconds)
 * so old observations auto-expire, keeping the log and the later summarization
 * input small (token frugality is a hard rule — see AGENTS.md).
 *
 * @param {number|string} userId  Numeric user id the observation is about.
 * @param {string} line  One-line observation (LLM-produced prose).
 */
export const appendObservation = async (userId, line) => {
  const obs = (line ?? "").trim();
  if (!userId || !obs) return;
  const ttl = Math.floor(Date.now() / 1000) + obsTtlDays() * 86400;
  await docClient.send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...obsKey(userId, new Date().toISOString()), obs, ttl },
    }),
  );
};

/**
 * Read a person's append-only observations, oldest first. Bounded by the
 * partition's TTL-expiring items and a hard `Limit`, so the summarization step
 * never assembles an unbounded payload.
 *
 * @param {number|string} userId  Numeric user id.
 * @returns {Promise<string[]>} Observation lines, oldest first.
 */
export const getObservations = async (userId) => {
  if (!userId) return [];
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :obs)",
      ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":obs": "OBS#" },
      Limit: 50,
    }),
  );
  return (Items ?? []).map((i) => i.obs).filter(Boolean);
};

/**
 * Write a person's free-text profile `summary` — and *only* that field. This is
 * the single place the LLM's prose (via the separate summarization step) reaches
 * the PROFILE item; code still owns every structured field around it. The
 * condition guards against creating a profile that recordSighting hasn't.
 *
 * @param {number|string} userId  Numeric user id.
 * @param {string} summary  Compressed free-text summary (LLM-produced prose).
 */
export const setProfileSummary = async (userId, summary) => {
  const text = (summary ?? "").trim();
  if (!userId || !text) return;
  await docClient.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: profileKey(userId),
      UpdateExpression: "SET #s = :s, last_updated = :t",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#s": "summary" },
      ExpressionAttributeValues: { ":s": text, ":t": new Date().toISOString() },
    }),
  );
};
