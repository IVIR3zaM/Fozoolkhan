// Tests for the core "when does the bot speak, and about what" behaviour:
// shouldRespond (the trigger gate) and replyContextOf (the referenced post).
// These pure functions decide every reply the bot makes in a group, so locking
// them down is what keeps normal messaging from silently changing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldRespond,
  replyContextOf,
  subjectSnippet,
  SUBJECT_OBS_FALLBACK,
  buildParticipantIndex,
} from "../src/index.js";
import { normalizeName } from "../src/db.js";

const BOT = "fozoolkhan_bot";

// A minimal Telegram `mention` entity over the bot's @username in `text`.
const mentionEntity = (text, username = BOT) => {
  const at = `@${username}`;
  const offset = text.indexOf(at);
  return { type: "mention", offset, length: at.length };
};

test("shouldRespond: ignores everything without a bot username", () => {
  assert.equal(shouldRespond({ chat: { type: "private" } }, ""), false);
  assert.equal(shouldRespond(null, BOT), false);
});

test("shouldRespond: private chat always answers (admin-only past the gate)", () => {
  const msg = { chat: { type: "private" }, text: "سلام" };
  assert.equal(shouldRespond(msg, BOT), true);
});

test("shouldRespond: group stays silent for an unaddressed message", () => {
  const msg = { chat: { type: "supergroup" }, text: "یه حرف معمولی" };
  assert.equal(shouldRespond(msg, BOT), false);
});

test("shouldRespond: group answers an @-mention by username", () => {
  const text = `@${BOT} نظرت چیه؟`;
  const msg = {
    chat: { type: "group" },
    text,
    entities: [mentionEntity(text)],
  };
  assert.equal(shouldRespond(msg, BOT), true);
});

test("shouldRespond: a mention of a different @username does not trigger", () => {
  const text = "@someone_else نظرت چیه؟";
  const msg = {
    chat: { type: "group" },
    text,
    entities: [{ type: "mention", offset: 0, length: "@someone_else".length }],
  };
  assert.equal(shouldRespond(msg, BOT), false);
});

test("shouldRespond: mention matching is case-insensitive", () => {
  const text = `@${BOT.toUpperCase()} سلام`;
  const msg = {
    chat: { type: "group" },
    text,
    entities: [{ type: "mention", offset: 0, length: BOT.length + 1 }],
  };
  assert.equal(shouldRespond(msg, BOT), true);
});

test("shouldRespond: a reply to the bot's own message triggers", () => {
  const msg = {
    chat: { type: "group" },
    text: "آره راست میگی",
    reply_to_message: { from: { username: BOT } },
  };
  assert.equal(shouldRespond(msg, BOT), true);
});

test("shouldRespond: a reply to someone else does not trigger", () => {
  const msg = {
    chat: { type: "group" },
    text: "آره راست میگی",
    reply_to_message: { from: { username: "another_user" } },
  };
  assert.equal(shouldRespond(msg, BOT), false);
});

test("shouldRespond: mentions in a media caption also trigger", () => {
  const caption = `@${BOT} اینو ببین`;
  const msg = {
    chat: { type: "group" },
    caption,
    caption_entities: [mentionEntity(caption)],
  };
  assert.equal(shouldRespond(msg, BOT), true);
});

test("replyContextOf: undefined when the message is not a reply", () => {
  assert.equal(replyContextOf({ text: "سلام" }, BOT), undefined);
});

test("replyContextOf: undefined when the replied-to message has no text", () => {
  const msg = { reply_to_message: { from: { first_name: "علی" } } };
  assert.equal(replyContextOf(msg, BOT), undefined);
});

test("replyContextOf: uses the other person's full name", () => {
  const msg = {
    reply_to_message: {
      from: { first_name: "علی", last_name: "رضایی", username: "ali" },
      text: "  چه خبر  ",
    },
  };
  assert.deepEqual(replyContextOf(msg, BOT), {
    name: "علی رضایی",
    text: "چه خبر",
    self: false,
  });
});

test("replyContextOf: flags the bot's own replied-to message as self", () => {
  const msg = {
    reply_to_message: { from: { username: BOT }, text: "قبلاً گفتم" },
  };
  assert.deepEqual(replyContextOf(msg, BOT), {
    name: "فضول‌خان",
    text: "قبلاً گفتم",
    self: true,
  });
});

test("replyContextOf: falls back to a generic name when none is known", () => {
  const msg = { reply_to_message: { from: {}, text: "یه چیزی" } };
  const ctx = replyContextOf(msg, BOT);
  assert.equal(ctx.name, "یه نفر");
  assert.equal(ctx.self, false);
});

test("replyContextOf: reads a replied-to media caption", () => {
  const msg = {
    reply_to_message: { from: { first_name: "رضا" }, caption: "عکس" },
  };
  assert.equal(replyContextOf(msg, BOT).text, "عکس");
});

// subjectSnippet — what the bot is told about the person it's asked *about*.
// The bug this guards against: a known person with observations but no summary
// yet (the summarizer only runs once a threshold accumulates) used to reach the
// model as just their name, so "what do you know about Hesam?" had no context.

test("subjectSnippet: prefers the compressed summary when one exists", () => {
  const subject = {
    names_seen: ["حسام"],
    summary: "همیشه دیر می‌رسه و قهوه‌ایه.",
  };
  // Even with raw observations present, an existing summary wins.
  assert.equal(
    subjectSnippet(subject, ["یه نکته‌ی دیگه"]),
    "حسام — همیشه دیر می‌رسه و قهوه‌ایه.",
  );
});

test("subjectSnippet: falls back to raw observations when there's no summary yet", () => {
  const subject = { names_seen: ["حسام"], summary: "" };
  assert.equal(
    subjectSnippet(subject, ["عاشق فوتباله", "از صبحونه متنفره"]),
    "حسام — عاشق فوتباله؛ از صبحونه متنفره",
  );
});

test("subjectSnippet: caps the fallback to the most recent observations", () => {
  const subject = { names_seen: ["حسام"], summary: "" };
  const obs = Array.from({ length: 9 }, (_, i) => `نکته${i}`);
  const snippet = subjectSnippet(subject, obs);
  const expectedTail = obs.slice(-SUBJECT_OBS_FALLBACK).join("؛ ");
  assert.equal(snippet, `حسام — ${expectedTail}`);
  // Older observations beyond the cap must not leak in.
  assert.ok(!snippet.includes("نکته0"));
});

test("subjectSnippet: just the name when there's no summary and no observations", () => {
  const subject = { names_seen: ["حسام"], summary: "" };
  assert.equal(subjectSnippet(subject, []), "حسام");
});

// buildParticipantIndex — the code-owned label→id map that grounds LLM
// coreference (Layer 2). The model returns a display label; this is what turns
// it back into a numeric id without ever exposing ids to the model.

test("buildParticipantIndex: maps a present participant's name to their id", () => {
  const map = buildParticipantIndex([
    { name: "Scorpion", user_id: 111, text: "سلام" },
    { name: "رضا", user_id: 222, text: "چطوری" },
  ]);
  assert.equal(map.get(normalizeName("Scorpion")), 111);
  assert.equal(map.get(normalizeName("رضا")), 222);
});

test("buildParticipantIndex: skips the bot's own lines (no id to ground)", () => {
  const map = buildParticipantIndex([
    { self: true, text: "قبلاً گفتم" },
    { name: "Scorpion", user_id: 111, text: "سلام" },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(normalizeName("Scorpion")), 111);
});

test("buildParticipantIndex: a label shared by two ids is dropped (ambiguous)", () => {
  const map = buildParticipantIndex([
    { name: "علی", user_id: 1, text: "a" },
    { name: "علی", user_id: 2, text: "b" },
  ]);
  // Same label, two people — we must not guess which one, so it grounds to null.
  assert.equal(map.get(normalizeName("علی")), null);
});

test("buildParticipantIndex: includes the replied-to author", () => {
  const map = buildParticipantIndex([], {
    first_name: "Sam",
    last_name: "Miga",
    id: 999,
  });
  assert.equal(map.get(normalizeName("Sam Miga")), 999);
});
