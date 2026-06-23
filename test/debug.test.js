// Tests for the admin-only debug surface: the #debug trigger detection, the
// transcript line rendering used in the dump, and the chunked sender that keeps
// a large dump under Telegram's per-message limit. These guard the "debug
// messages won't be affected later" requirement.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  wantsDebug,
  DEBUG_FLAG,
  debugLine,
  sendChunked,
  TELEGRAM_CHUNK,
} from "../src/index.js";

const ADMIN = "424242";
process.env.ADMIN_USER_ID = ADMIN;

test("DEBUG_FLAG: matches #debug as a standalone token only", () => {
  assert.ok(DEBUG_FLAG.test("@bot #debug چی شد"));
  assert.ok(DEBUG_FLAG.test("#debug"));
  assert.ok(DEBUG_FLAG.test("سلام #debug"));
  // Substrings must NOT trip it.
  assert.ok(!DEBUG_FLAG.test("#debugging"));
  assert.ok(!DEBUG_FLAG.test("xx#debugxx"));
});

test("wantsDebug: true only for the admin with the marker", () => {
  const admin = { id: Number(ADMIN) };
  const other = { id: 1 };
  assert.equal(wantsDebug({ from: admin, text: "@bot #debug" }), true);
  // Admin without the marker → normal reply, not debug.
  assert.equal(wantsDebug({ from: admin, text: "@bot سلام" }), false);
  // Non-admin with the marker → never debug (it's an admin-only harness).
  assert.equal(wantsDebug({ from: other, text: "@bot #debug" }), false);
});

test("wantsDebug: reads the marker from a media caption too", () => {
  const admin = { id: Number(ADMIN) };
  assert.equal(wantsDebug({ from: admin, caption: "#debug" }), true);
});

test("wantsDebug: safe on a malformed message", () => {
  assert.equal(wantsDebug(undefined), false);
  assert.equal(wantsDebug({}), false);
});

test("debugLine: marks the bot's own lines distinctly", () => {
  assert.equal(
    debugLine({ self: true, text: "گفتم" }),
    "فضول‌خان (خود بات): گفتم",
  );
  assert.equal(debugLine({ name: "علی", text: "سلام" }), "علی: سلام");
  assert.equal(debugLine({ text: "ناشناس" }), "یه نفر: ناشناس");
});

// --- sendChunked: exercised against a stubbed Telegram fetch. ---

let calls;
let originalFetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  calls = [];
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => "" };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("sendChunked: a short message goes out in a single call", async () => {
  await sendChunked(123, "کوتاه", 55);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "کوتاه");
  assert.equal(calls[0].reply_to_message_id, 55);
});

test("sendChunked: a long dump is split into multiple sub-limit chunks", async () => {
  const text = "x".repeat(TELEGRAM_CHUNK * 2 + 10);
  await sendChunked(123, text, 55);

  assert.equal(calls.length, 3); // ceil((2*N+10)/N)
  for (const c of calls) {
    assert.ok(c.text.length <= TELEGRAM_CHUNK);
  }
  // Reassembling the chunks must reproduce the original dump exactly.
  assert.equal(calls.map((c) => c.text).join(""), text);
});

test("sendChunked: only the first chunk threads under the trigger", async () => {
  const text = "y".repeat(TELEGRAM_CHUNK + 5);
  await sendChunked(123, text, 55);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].reply_to_message_id, 55);
  assert.equal(calls[1].reply_to_message_id, undefined);
});
