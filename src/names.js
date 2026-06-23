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
  recordUsername,
  resolveUsername,
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
 * Split a person's stored name (which may be a multi-word `first_name` like
 * «قلی گاوکش») into the individual normalized word keys that someone would
 * actually type to refer to them. This must mirror extractNameCandidates'
 * tokenization on the read side: a spoken message is matched one whitespace-
 * delimited word at a time, so a name has to be *indexed* the same way or a
 * multi-word first_name can never be hit by a single spoken token. Skips junk
 * (one-char fragments) but keeps stopword-looking tokens — a real name might
 * coincide with one — and dedupes.
 *
 * @param {string} name  A raw name string (first_name, a mention label, …).
 * @returns {string[]} Normalized per-word name keys.
 */
export const nameTokens = (name) => {
  if (!name) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(name).split(/[\s\n]+/)) {
    const key = normalizeName(raw);
    if (key.length < 2) continue; // stray punctuation / single chars.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

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
 * Score the candidate people a single spoken `name` could refer to, biased by how
 * often the asker interacts with each (the EDGE count), best first. Shared by the
 * single-name resolver and the multi-subject resolver. Empty when the name is
 * unknown to the NAME# index.
 *
 * @param {number|string} askerId  The asker's numeric user id.
 * @param {string} name  A normalized spoken-name key.
 * @returns {Promise<Array<{ userId: number|string, score: number }>>}
 */
const scoreCandidates = async (askerId, name) => {
  const candidates = await getNameCandidates(name);
  if (!candidates.length) return [];
  const scored = await Promise.all(
    candidates.map(async (c) => {
      const edge = askerId ? await getEdgeCount(askerId, c.userId) : 0;
      return { userId: c.userId, score: c.weight * (1 + edge) };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored;
};

// Confident when there's a single candidate, or the top clearly outweighs the
// runner-up after edge biasing. Otherwise the ambiguity itself becomes the joke.
const isConfident = (scored) =>
  scored.length === 1 || scored[0].score >= 2 * scored[1].score;

/**
 * Resolve which person the *first* spoken name in `text` refers to. Kept for the
 * observation-target path, which resolves one name at a time. For answering a
 * message that may name several people, use resolveSubjects.
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
    const scored = await scoreCandidates(askerId, name);
    if (!scored.length) continue;
    if (isConfident(scored)) {
      return { status: "confident", name, userId: scored[0].userId };
    }
    return { status: "ambiguous", name, candidates: scored };
  }
  return { status: "none" };
};

/**
 * Resolve *every* person named in `text`, not just the first — so "حسام و علی رو
 * چی می‌دونی" pulls context for both. Each candidate name token is scored the
 * same edge-biased way as resolveName; a name resolves to a person only when the
 * match is confident. The asker themselves and duplicate ids are dropped, so the
 * caller can load each subject's profile once. Names that stay ambiguous are
 * returned separately so the bot can still make the "which one?" joke.
 *
 * @param {number|string} askerId  The asker's numeric user id.
 * @param {string} text  The triggering message text.
 * @param {string} [botUsername]  Bot @username to ignore in the text.
 * @returns {Promise<{
 *   confident: Array<{ name: string, userId: number|string }>,
 *   ambiguous: Array<{ name: string,
 *     candidates: Array<{ userId: number|string, score: number }> }>,
 *   unresolved: string[],
 * }>}
 *   `unresolved` holds spoken-name tokens the NAME# index knew nothing about —
 *   the candidates LLM coreference may later ground to a present participant.
 */
export const resolveSubjects = async (askerId, text, botUsername) => {
  const confident = [];
  const ambiguous = [];
  const unresolved = [];
  const seen = new Set();
  for (const name of extractNameCandidates(text, botUsername)) {
    const scored = await scoreCandidates(askerId, name);
    if (!scored.length) {
      unresolved.push(name);
      continue;
    }
    if (isConfident(scored)) {
      const userId = scored[0].userId;
      // Skip the asker (we already have their own snippet) and any person we've
      // already pulled in via another spoken name in the same message.
      if (String(userId) === String(askerId)) continue;
      if (seen.has(String(userId))) continue;
      seen.add(String(userId));
      confident.push({ name, userId });
    } else {
      ambiguous.push({ name, candidates: scored });
    }
  }
  return { confident, ambiguous, unresolved };
};

// Reply-vocative alias learning (Layer 1). A short reply is usually addressing
// the replied-to person — often by a nickname that has nothing to do with their
// Telegram first_name («Scorpion» whom everyone calls «حسن»). So each spoken-name
// token in a short reply is a *weak* alias signal for that person's id. The small
// weight, plus the fact that only the real nickname recurs across many replies to
// the *same* id (random words scatter across different ids), is what keeps the
// NAME# index from filling up with noise.
const REPLY_ALIAS_MAX_TOKENS = 4;
const REPLY_ALIAS_WEIGHT = 0.34;

// Tokens the model uses to mean "this note is about the person who just spoke",
// folded to the speaker's own id rather than looked up as a third party.
const SELF_REFERENCES = new Set(["خودش", "خودت", "گوینده", "من", "طرف"]);

/**
 * Decide which numeric user id an LLM observation tagged with a spoken `name` is
 * about — so a note like «حسن: تهدید می‌کنه» lands on Hassan's profile, learned
 * from what *others* say, not only from his own words. Code owns the identity
 * decision; the LLM only supplied the prose and the spoken label.
 *
 *   - A self-reference, or the speaker's own name → the speaker.
 *   - The bot's own name → null (we don't profile ourselves).
 *   - Otherwise resolve the name the same edge-biased way as addressing; only a
 *     *confident* match anchors the note. Anything unresolved is dropped rather
 *     than mis-attributed (never store an observation we can't pin to an id).
 *
 * @param {object} speaker  The speaker's Telegram `from` object.
 * @param {string} name  The spoken name the observation is tagged with.
 * @param {string} [botUsername]  Bot @username, used both to skip self-notes
 *   about the bot and as the resolver's ignore token.
 * @returns {Promise<number|string|null>} The target user id, or null to skip.
 */
export const resolveObservationTarget = async (speaker, name, botUsername) => {
  const nk = normalizeName(name);
  if (!nk) return null;

  if (botUsername && nk === normalizeName(botUsername)) return null;
  if (nk === normalizeName("فضول‌خان") || nk === normalizeName("فضول"))
    return null;

  const speakerNames = [
    speaker?.first_name,
    speaker?.last_name,
    speaker?.username,
  ]
    .map(normalizeName)
    .filter(Boolean);
  if (SELF_REFERENCES.has(nk) || speakerNames.includes(nk)) {
    return speaker?.id ?? null;
  }

  const resolution = await resolveName(speaker?.id, name, botUsername);
  return resolution.status === "confident" ? resolution.userId : null;
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
 *   - an explicit text-mention -> the strongest "this label means this id",
 *   - a bare `@username` mention -> an edge, by resolving the username to an id
 *     through the code-owned username index (milestone 9: the common way one
 *     person addresses another in a group).
 * Every place a user with a @username appears also feeds that username index, so
 * the lookup self-improves. Runs for every message, not only when the bot is
 * addressed, so the table self-improves over time with zero LLM involvement.
 *
 * @param {object} message  Telegram `message` object.
 */
export const learnFromMessage = async (message) => {
  const from = message?.from;
  if (!from?.id || from.is_bot) return;

  const tasks = [];

  // Index a name per word, not as one string: a Telegram first_name (or a
  // mention label) is often multi-word («قلی گاوکش»), but the resolver looks
  // names up one spoken token at a time — so each word must be its own NAME# key.
  const bumpName = (name, userId) => {
    for (const token of nameTokens(name)) {
      tasks.push(bumpNameWeight(token, userId));
    }
  };

  if (from.first_name) bumpName(from.first_name, from.id);
  if (from.username) tasks.push(recordUsername(from.username, from.id));

  // Reply addressing: the sender interacts with the replied-to person, and that
  // person is being addressed by their name. Skip replies to bots (incl. us).
  const repliedTo = message.reply_to_message?.from;
  if (repliedTo?.id && !repliedTo.is_bot && repliedTo.id !== from.id) {
    tasks.push(bumpEdge(from.id, repliedTo.id));
    if (repliedTo.first_name) {
      bumpName(repliedTo.first_name, repliedTo.id);
    }
    if (repliedTo.username) {
      tasks.push(recordUsername(repliedTo.username, repliedTo.id));
    }

    // Layer 1: a short reply is likely addressing the replied-to person by name.
    // Learn each spoken-name token as a weak alias for their id.
    const replyText = message.text ?? message.caption ?? "";
    const tokens = extractNameCandidates(replyText, process.env.BOT_USERNAME);
    if (tokens.length && tokens.length <= REPLY_ALIAS_MAX_TOKENS) {
      for (const token of tokens) {
        tasks.push(bumpNameWeight(token, repliedTo.id, REPLY_ALIAS_WEIGHT));
      }
    }
  }

  // Explicit text-mentions carry both the spoken label and the user id.
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  for (const e of entities) {
    if (e.type === "text_mention" && e.user?.id && !e.user.is_bot) {
      const label = text.substr(e.offset, e.length);
      bumpName(label, e.user.id);
      if (e.user.username)
        tasks.push(recordUsername(e.user.username, e.user.id));
      if (e.user.id !== from.id) tasks.push(bumpEdge(from.id, e.user.id));
      continue;
    }
    // Bare `@username` mentions carry only the label. Resolve it to an id via
    // the username index and, if we know who it is, record that the sender
    // addresses that person (an edge). Only fires once the target has spoken.
    if (e.type === "mention") {
      const username = text.substr(e.offset, e.length); // includes leading @.
      tasks.push(
        (async () => {
          const targetId = await resolveUsername(username);
          if (targetId && targetId !== from.id) {
            await bumpEdge(from.id, targetId);
          }
        })(),
      );
    }
  }

  await Promise.allSettled(tasks);
};
