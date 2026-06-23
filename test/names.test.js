// Tests for the pure, code-owned name handling that feeds resolution: candidate
// extraction from a message and the normalization that keys every NAME#/USERNAME#
// lookup. Getting these stable keeps "who did they mean" learning consistent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractNameCandidates, nameTokens } from "../src/names.js";
import { normalizeName, currentMonth } from "../src/db.js";

const BOT = "fozoolkhan_bot";

test("extractNameCandidates: empty / falsy text yields nothing", () => {
  assert.deepEqual(extractNameCandidates("", BOT), []);
  assert.deepEqual(extractNameCandidates(undefined, BOT), []);
});

test("extractNameCandidates: drops the bot mention and stopwords", () => {
  const got = extractNameCandidates(`@${BOT} علی کیه`, BOT);
  assert.ok(got.includes("علی"));
  assert.ok(!got.includes("کیه")); // stopword
  assert.ok(!got.includes(`@${BOT}`)); // bot mention skipped
});

test("extractNameCandidates: deduplicates and skips one-char tokens", () => {
  const got = extractNameCandidates("علی علی ب رضا", BOT);
  assert.deepEqual(
    got.filter((g) => g === "علی").length,
    1,
    "duplicate names collapse",
  );
  assert.ok(!got.includes("ب")); // single char dropped
});

test("extractNameCandidates: caps the number of lookups", () => {
  const many = Array.from({ length: 30 }, (_, i) => `نام${i}`).join(" ");
  assert.ok(extractNameCandidates(many, BOT).length <= 12);
});

test("nameTokens: splits a multi-word first_name into per-word keys", () => {
  // The bug: a multi-word first_name was stored as one NAME# key, so a single
  // spoken token («قلی») could never match it. Each word must be indexed.
  assert.deepEqual(nameTokens("قلی گاوکش"), ["قلی", "گاوکش"]);
});

test("nameTokens: normalizes each word the same way the resolver looks them up", () => {
  // Arabic yeh folds to Persian, leading @ and punctuation stripped — so the
  // indexed key equals what extractNameCandidates produces for the same word.
  assert.deepEqual(nameTokens("«علي» @Reza"), ["علی", "reza"]);
});

test("nameTokens: drops one-char fragments and dedupes", () => {
  assert.deepEqual(nameTokens("رضا ب رضا"), ["رضا"]);
});

test("nameTokens: empty / falsy name yields nothing", () => {
  assert.deepEqual(nameTokens(""), []);
  assert.deepEqual(nameTokens(undefined), []);
});

test("nameTokens: a single-word name is unchanged", () => {
  assert.deepEqual(nameTokens("حسام"), ["حسام"]);
});

test("normalizeName: trims, lowercases and strips a leading @", () => {
  assert.equal(normalizeName("  @Ali "), "ali");
});

test("normalizeName: folds Arabic yeh/kaf to Persian forms", () => {
  // Arabic yeh (ي) and kaf (ك) must key the same as Persian (ی / ک).
  assert.equal(normalizeName("علي"), normalizeName("علی"));
  assert.equal(normalizeName("کيک"), normalizeName("کیک"));
});

test("normalizeName: strips surrounding punctuation", () => {
  assert.equal(normalizeName("«علی»"), "علی");
  assert.equal(normalizeName("رضا!"), "رضا");
});

test("normalizeName: empty / nullish input is the empty key", () => {
  assert.equal(normalizeName(""), "");
  assert.equal(normalizeName(undefined), "");
});

test("currentMonth: returns a YYYY-MM key", () => {
  assert.match(currentMonth(), /^\d{4}-\d{2}$/);
});
