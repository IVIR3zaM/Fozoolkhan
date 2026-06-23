// Tests for the model-facing contract: how the single user turn is assembled
// (buildUserContent) and how the piggybacked observation block is parsed back
// out (parseObservationBlock). These shape every reply and every memory write,
// so PROMPTS.md leans on them staying stable — pin the structure here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUserContent,
  parseObservationBlock,
  parseAliasBlock,
  splitControlBlocks,
} from "../src/bedrock.js";

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
  assert.doesNotMatch(out, /نکته‌ای درباره‌ش/); // no speaker snippet section
  assert.doesNotMatch(out, /می‌پرسه/); // no "asking about" subjects section
});

test("buildUserContent: keeps the speaker as addressee and subjects as who they ask about", () => {
  // The bug this guards: when Reza asks about Hesam, the model used to be told
  // Hesam was its addressee. Now the speaker (Reza) is the addressee and Hesam is
  // explicitly framed as someone being asked about — not replied to.
  const out = buildUserContent({
    profileSnippet: "رضا — رفیقِ شوخ",
    subjectSnippets: ["حسام — طنزِ سیاسی تند"],
  });
  // Speaker is the one being replied to.
  assert.match(out, /گوینده‌ی پیام که الان داری بهش جواب می‌دی همینه/);
  assert.match(out, /رضا — رفیقِ شوخ/);
  // Subject is framed as "asked about", and the model is told not to address them.
  assert.match(out, /گوینده داره ازت درباره‌ی این آدم\(ها\) می‌پرسه/);
  assert.match(out, /جوابت رو به خودِ گوینده بده، نه به این‌ها/);
  assert.match(out, /حسام — طنزِ سیاسی تند/);
});

test("buildUserContent: lists several asked-about subjects", () => {
  const out = buildUserContent({
    profileSnippet: "رضا",
    subjectSnippets: ["حسام — یک", "علی — دو"],
  });
  assert.match(out, /- حسام — یک/);
  assert.match(out, /- علی — دو/);
});

test("buildUserContent: asks for coreference only when there are unresolved names", () => {
  // No unresolved names → the ALIAS section (and its delimiter) must not appear.
  const without = buildUserContent({
    recentMessages: [{ name: "x", text: "y" }],
  });
  assert.doesNotMatch(without, /###ALIAS###/);

  // With unresolved names → the section lists them and instructs the delimiter.
  const withNames = buildUserContent({
    recentMessages: [{ name: "Scorpion", text: "سلام" }],
    unresolvedNames: ["حسن"],
  });
  assert.match(withNames, /###ALIAS###/);
  assert.match(withNames, /حسن/);
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

test("parseAliasBlock: parses spokenName=label pairs, trimming bullets", () => {
  const block = "- حسن = Scorpion\n* سام = Sam Miga";
  assert.deepEqual(parseAliasBlock(block), [
    { name: "حسن", label: "Scorpion" },
    { name: "سام", label: "Sam Miga" },
  ]);
});

test("parseAliasBlock: skips lines without a name before the equals", () => {
  assert.deepEqual(parseAliasBlock("= بدون اسم\nحسن = Scorpion"), [
    { name: "حسن", label: "Scorpion" },
  ]);
});

test("splitControlBlocks: separates reply, observations, and aliases in any order", () => {
  const raw =
    "سلام رفیق\n###OBS###\nحسن: اهل فوتباله\n###ALIAS###\nحسن = Scorpion";
  const { text, obsBlock, aliasBlock } = splitControlBlocks(raw);
  assert.equal(text, "سلام رفیق");
  assert.deepEqual(parseObservationBlock(obsBlock), [
    { name: "حسن", note: "اهل فوتباله" },
  ]);
  assert.deepEqual(parseAliasBlock(aliasBlock), [
    { name: "حسن", label: "Scorpion" },
  ]);
});

test("splitControlBlocks: handles the alias block appearing before observations", () => {
  const raw = "جواب\n###ALIAS###\nحسن = Scorpion\n###OBS###\nحسن: شوخه";
  const { text, obsBlock, aliasBlock } = splitControlBlocks(raw);
  assert.equal(text, "جواب");
  assert.deepEqual(parseAliasBlock(aliasBlock), [
    { name: "حسن", label: "Scorpion" },
  ]);
  assert.deepEqual(parseObservationBlock(obsBlock), [
    { name: "حسن", note: "شوخه" },
  ]);
});

test("splitControlBlocks: a completion with no delimiters is all reply", () => {
  const { text, obsBlock, aliasBlock } = splitControlBlocks("فقط جواب");
  assert.equal(text, "فقط جواب");
  assert.equal(obsBlock, "");
  assert.equal(aliasBlock, "");
});
