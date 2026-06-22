// Name resolution + weight learning for فضول‌خان (Fozoolkhan).
//
// Milestone 7: the canonical example of "code owns structure, the LLM owns
// prose". When the bot is addressed, code tries to work out *which person* a
// spoken name refers to, biased by who the asker actually talks with. When it is
// confident it folds that person's profile into the context; when it is not, it
// hands the LLM a note so the ambiguity itself becomes the joke. Separately,
// every visible message teaches the name->person map and the interaction edges —
// all in code, never the LLM.

import {
  bumpEdge,
  bumpNameWeight,
  getEdgeCount,
  getNameCandidates,
  getProfile,
  normalizeName,
} from "./db.js";

// Very common Persian words that look like tokens but are never names. Skipping
// them avoids pointless NAME# lookups (and keeps the resolver token-frugal).
const STOPWORDS = new Set([
  "کیه",
  "کی",
  "چیه",
  "چی",
  "کجا",
  "کجاست",
  "که",
  "رو",
  "به",
  "از",
  "با",
  "این",
  "اون",
  "یه",
  "من",
  "تو",
  "ما",
  "شما",
  "اونا",
  "بود",
  "هست",
  "نیست",
  "الان",
  "چرا",
  "چطور",
  "واسه",
  "برای",
]);

/**
 * Pull candidate spoken-name tokens out of a message, skipping the bot mention,
 * stopwords, and junk. Returns normalized keys, deduplicated and capped so the
 * resolver never fans out into an unbounded number of DynamoDB lookups.
 *
 * @param {string} text  Message text (or caption).
 * @param {string} [botUsername]  The bot's @username (without @), to skip.
 * @returns {string[]} Normalized candidate name keys.
 */
export const extractNameCandidates = (text, botUsername) => {
  if (!text) return [];
  const wanted = botUsername ? `@${botUsername}`.toLowerCase() : null;
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split(/[\s\n]+/)) {
    if (!raw) continue;
    if (wanted && raw.toLowerCase() === wanted) continue;
    const key = normalizeName(raw);
    if (key.length < 2) continue; // stray punctuation / single chars.
    if (STOPWORDS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 12) break; // frugal cap on lookups.
  }
  return out;
};

/**
 * Resolve which person a spoken name in `text` refers to. For each candidate
 * name token, the name weights are biased by how often the asker interacts with
 * each person (the EDGE count), so the resolver leans toward people the asker
 * actually talks with/about.
 *
 * @param {number|string} askerId  The asker's numeric user id.
 * @param {string} text  The triggering message text.
 * @param {string} [botUsername]  Bot @username to ignore in the text.
 * @returns {Promise<
 *   | { status: "none" }
 *   | { status: "confident", name: string, userId: number|string }
 *   | { status: "ambiguous", name: string,
 *       candidates: Array<{ userId: number|string, score: number }> }
 * >}
 */
export const resolveName = async (askerId, text, botUsername) => {
  for (const name of extractNameCandidates(text, botUsername)) {
    const candidates = await getNameCandidates(name);
    if (!candidates.length) continue;

    const scored = await Promise.all(
      candidates.map(async (c) => {
        const edge = askerId ? await getEdgeCount(askerId, c.userId) : 0;
        return { userId: c.userId, score: c.weight * (1 + edge) };
      })
    );
    scored.sort((a, b) => b.score - a.score);

    const [top, second] = scored;
    // Confident when there's a single candidate, or the top clearly outweighs
    // the runner-up after edge biasing. Otherwise the ambiguity is the joke.
    if (!second || top.score >= 2 * second.score) {
      return { status: "confident", name, userId: top.userId };
    }
    return { status: "ambiguous", name, candidates: scored };
  }
  return { status: "none" };
};

/**
 * Build a short Persian instruction telling the bot it knows several people by
 * the same name and should tease about which one is meant, rather than guess.
 * This is the only thing handed to the LLM — the structure (who the candidates
 * are) stays code-owned.
 *
 * @param {{ name: string, candidates: Array<{userId: number|string}> }} amb
 * @returns {Promise<string>}
 */
export const describeAmbiguity = async ({ name, candidates }) => {
  const labels = [];
  for (const c of candidates.slice(0, 3)) {
    const p = await getProfile(c.userId);
    labels.push(p?.names_seen?.[0] || p?.usernames_seen?.[0] || "یکی");
  }
  return `چند نفر رو با اسم «${name}» می‌شناسی (${labels.join("، ")}) و مطمئن نیستی منظورش کدومه. به‌جای جواب مستقیم، بامزه بپرس کدوم «${name}» رو می‌گه.`;
};

/**
 * Learn name and edge weights from a visible message — entirely in code, from
 * concrete addressing signals:
 *   - the sender's own first name -> themselves (activity grows the weight),
 *   - a reply to another real person -> an edge plus that person's name,
 *   - an explicit text-mention -> the strongest "this label means this id".
 * Runs for every message, not only when the bot is addressed, so the table
 * self-improves over time with zero LLM involvement.
 *
 * @param {object} message  Telegram `message` object.
 */
export const learnFromMessage = async (message) => {
  const from = message?.from;
  if (!from?.id || from.is_bot) return;

  const tasks = [];
  if (from.first_name) tasks.push(bumpNameWeight(from.first_name, from.id));

  // Reply addressing: the sender interacts with the replied-to person, and that
  // person is being addressed by their name. Skip replies to bots (incl. us).
  const repliedTo = message.reply_to_message?.from;
  if (repliedTo?.id && !repliedTo.is_bot && repliedTo.id !== from.id) {
    tasks.push(bumpEdge(from.id, repliedTo.id));
    if (repliedTo.first_name) {
      tasks.push(bumpNameWeight(repliedTo.first_name, repliedTo.id));
    }
  }

  // Explicit text-mentions carry both the spoken label and the user id.
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  for (const e of entities) {
    if (e.type !== "text_mention" || !e.user?.id || e.user.is_bot) continue;
    const label = text.substr(e.offset, e.length);
    tasks.push(bumpNameWeight(label, e.user.id));
    if (e.user.id !== from.id) tasks.push(bumpEdge(from.id, e.user.id));
  }

  await Promise.allSettled(tasks);
};
