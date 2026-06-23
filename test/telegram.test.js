// Tests for the outgoing Telegram request shapes, against a stubbed fetch. Every
// reply, admin overview, and approval toast goes through these, so the request
// bodies (and the error-on-non-2xx behaviour) are part of the contract.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  sendMessage,
  setMyCommands,
  answerCallbackQuery,
} from "../src/telegram.js";

let calls;
let nextResponse;
let originalFetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  calls = [];
  nextResponse = { ok: true, status: 200, text: async () => "" };
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return nextResponse;
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("sendMessage: minimal body carries chat_id and text only", async () => {
  await sendMessage(7, "سلام");
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: 7, text: "سلام" });
});

test("sendMessage: includes reply id and markup when given", async () => {
  const markup = { inline_keyboard: [] };
  await sendMessage(7, "hi", 99, markup);
  assert.equal(calls[0].body.reply_to_message_id, 99);
  assert.deepEqual(calls[0].body.reply_markup, markup);
});

test("sendMessage: throws with status detail on a non-2xx response", async () => {
  nextResponse = { ok: false, status: 403, text: async () => "forbidden" };
  await assert.rejects(
    () => sendMessage(7, "hi"),
    /sendMessage failed: 403 forbidden/
  );
});

test("setMyCommands: sends commands and an optional scope", async () => {
  const cmds = [{ command: "groups", description: "..." }];
  const scope = { type: "chat", chat_id: 1 };
  await setMyCommands(cmds, scope);
  assert.match(calls[0].url, /\/setMyCommands$/);
  assert.deepEqual(calls[0].body.commands, cmds);
  assert.deepEqual(calls[0].body.scope, scope);
});

test("answerCallbackQuery: carries the id and the optional toast text", async () => {
  await answerCallbackQuery("cbid", "فعال شد ✅");
  assert.match(calls[0].url, /\/answerCallbackQuery$/);
  assert.equal(calls[0].body.callback_query_id, "cbid");
  assert.equal(calls[0].body.text, "فعال شد ✅");
});

test("answerCallbackQuery: omits text when none is given", async () => {
  await answerCallbackQuery("cbid");
  assert.equal("text" in calls[0].body, false);
});
