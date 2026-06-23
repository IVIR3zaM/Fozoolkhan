// Tests for the model-facing contract: how the single user turn is assembled
// (buildUserContent) and how the piggybacked observation block is parsed back
// out (parseObservationBlock). These shape every reply and every memory write,
// so PROMPTS.md leans on them staying stable — pin the structure here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildUserContent, parseObservationBlock } from "../src/bedrock.js";

test("buildUserContent: always ends by asking for an in-character reply", () => {
  const out = buildUserContent({});
  assert.match(out, /به‌عنوان فضول‌خان/);
  // And always instructs the observation block with the delimiter.
  assert.match(out, /###OBS###/);
});

test("buildUserContent: renders the recent transcript oldest-first", () => {
  const out = buildUserContent({
    recentMessages: [
      { name: "علی", text: "اول" },
      { name: "رضا", text: "دوم" },
    ],
  });
  assert.ok(out.indexOf("علی: اول") < out.indexOf("رضا: دوم"));
});

test("buildUserContent: marks the bot's own past lines with (خودت)", () => {
  const out = buildUserContent({
    recentMessages: [{ self: true, text: "قبلاً گفتم" }],
  });
  assert.match(out, /فضول‌خان \(خودت\): قبلاً گفتم/);
});

test("buildUserContent: includes the replied-to post and the profile snippet", () => {
  const out = buildUserContent({
    replyTo: { name: "علی", text: "حرف قبلی" },
    profileSnippet: "علی — اهل شوخی",
  });
  assert.match(out, /ریپلای/);
  assert.match(out, /علی: حرف قبلی/);
  assert.match(out, /علی — اهل شوخی/);
});

test("buildUserContent: omits optional sections when not provided", () => {
  const out = buildUserContent({ recentMessages: [{ name: "x", text: "y" }] });
  assert.doesNotMatch(out, /ریپلای/);
  assert.doesNotMatch(out, /مخاطبته/);
});

test("parseObservationBlock: parses name:note pairs, trimming bullets", () => {
  const block = "- علی: اهل فوتباله\n* رضا: همیشه دیر میاد";
  assert.deepEqual(parseObservationBlock(block), [
    { name: "علی", note: "اهل فوتباله" },
    { name: "رضا", note: "همیشه دیر میاد" },
  ]);
});

test("parseObservationBlock: skips lines without a name before the colon", () => {
  const block = ": بدون اسم\nعلی: درست\n   \n";
  assert.deepEqual(parseObservationBlock(block), [
    { name: "علی", note: "درست" },
  ]);
});

test("parseObservationBlock: keeps colons inside the note", () => {
  const [obs] = parseObservationBlock("علی: ساعت ۸: قرار داره");
  assert.equal(obs.note, "ساعت ۸: قرار داره");
});

test("parseObservationBlock: caps at four observations (token frugality)", () => {
  const block = ["a:1", "b:2", "c:3", "d:4", "e:5", "f:6"].join("\n");
  assert.equal(parseObservationBlock(block).length, 4);
});

test("parseObservationBlock: empty / nullish input yields no observations", () => {
  assert.deepEqual(parseObservationBlock(""), []);
  assert.deepEqual(parseObservationBlock(undefined), []);
});
