// Tests for the admin surface: who counts as the admin, how slash-commands are
// parsed, and how the read-only overviews (/groups, /usage) and the approval
// keyboards render. These are the pieces the admin sees and taps; pinning them
// down keeps "more admin commands" from quietly breaking the existing ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAdmin,
  parseCommand,
  renderGroups,
  renderUsage,
  statusLabel,
  approvalKeyboard,
  groupsKeyboard,
  monthlyResetDate,
  ADMIN_COMMANDS,
  ADMIN_HELP,
} from "../src/index.js";

// isAdmin reads process.env, so set a known admin id for the whole file.
process.env.ADMIN_USER_ID = "424242";

test("isAdmin: matches the configured admin, numeric or string", () => {
  assert.equal(isAdmin(424242), true);
  assert.equal(isAdmin("424242"), true);
});

test("isAdmin: rejects anyone else and missing ids", () => {
  assert.equal(isAdmin(999), false);
  assert.equal(isAdmin(undefined), false);
});

test("isAdmin: false when no admin is configured", () => {
  const saved = process.env.ADMIN_USER_ID;
  delete process.env.ADMIN_USER_ID;
  try {
    assert.equal(isAdmin(424242), false);
  } finally {
    process.env.ADMIN_USER_ID = saved;
  }
});

test("parseCommand: plain command, no argument", () => {
  assert.deepEqual(parseCommand("/groups"), { cmd: "groups", arg: "" });
});

test("parseCommand: tolerates the /cmd@botname form", () => {
  assert.deepEqual(parseCommand("/approve@fozoolkhan_bot"), {
    cmd: "approve",
    arg: "",
  });
});

test("parseCommand: captures a trailing argument", () => {
  assert.deepEqual(parseCommand("/approve -100123"), {
    cmd: "approve",
    arg: "-100123",
  });
});

test("parseCommand: lowercases the command name", () => {
  assert.equal(parseCommand("/HELP").cmd, "help");
});

test("parseCommand: null for non-commands", () => {
  assert.equal(parseCommand("سلام"), null);
  assert.equal(parseCommand("not /a command"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(undefined), null);
});

test("statusLabel: known statuses get their Persian label", () => {
  assert.match(statusLabel("approved"), /فعال/);
  assert.match(statusLabel("pending"), /انتظار/);
  assert.match(statusLabel("denied"), /ردشده/);
  assert.match(statusLabel("removed"), /حذف/);
});

test("statusLabel: unknown status falls back without throwing", () => {
  assert.match(statusLabel("weird"), /weird/);
  assert.match(statusLabel(undefined), /نامعلوم/);
});

test("renderGroups: empty list shows the no-groups line and no keyboard", () => {
  const out = renderGroups([]);
  assert.match(out.text, /هیچ گروهی/);
  assert.equal(out.replyMarkup, undefined);
});

test("renderGroups: lists each group with its status and a keyboard", () => {
  const chats = [
    { chatId: -100, status: "approved", title: "رفقا" },
    { chatId: -200, status: "pending", title: "گروه دوم" },
  ];
  const out = renderGroups(chats);
  assert.match(out.text, /«رفقا»/);
  assert.match(out.text, /«گروه دوم»/);
  // One alter-row per group, each with an approve + deny button.
  assert.equal(out.replyMarkup.inline_keyboard.length, 2);
});

test("renderUsage: shows spend, ceiling, remaining and reset date", () => {
  const text = renderUsage(1.5, 5);
  assert.match(text, /1\.50/); // spent
  assert.match(text, /5\.00/); // ceiling
  assert.match(text, /3\.50/); // remaining
  assert.match(text, new RegExp(monthlyResetDate()));
  assert.doesNotMatch(text, /ته کشید/); // not over budget yet
});

test("renderUsage: clamps remaining at zero and flags over-budget", () => {
  const text = renderUsage(7, 5);
  assert.match(text, /0\.00/); // remaining clamped
  assert.match(text, /ته کشید/); // over-budget note present
});

test("approvalKeyboard: encodes the target chat id in callback_data", () => {
  const kb = approvalKeyboard(-100777);
  const [approve, deny] = kb.inline_keyboard[0];
  assert.equal(approve.callback_data, "approve:-100777");
  assert.equal(deny.callback_data, "deny:-100777");
});

test("groupsKeyboard: one approve/deny row per chat, id in callback_data", () => {
  const kb = groupsKeyboard([{ chatId: -1, title: "x" }]);
  const [approve, deny] = kb.inline_keyboard[0];
  assert.equal(approve.callback_data, "approve:-1");
  assert.equal(deny.callback_data, "deny:-1");
});

test("groupsKeyboard: long titles are truncated on the button", () => {
  const long = "ع".repeat(50);
  const kb = groupsKeyboard([{ chatId: 1, title: long }]);
  const approveText = kb.inline_keyboard[0][0].text;
  // "✅ " prefix + at most 24 chars of title.
  assert.ok(approveText.length <= 2 + 24);
});

test("ADMIN_COMMANDS and ADMIN_HELP stay in sync on the core commands", () => {
  const names = ADMIN_COMMANDS.map((c) => c.command);
  // The commands the help text walks the admin through must be registered.
  for (const cmd of ["groups", "usage", "approve", "deny"]) {
    assert.ok(names.includes(cmd), `missing registered command: ${cmd}`);
    assert.match(ADMIN_HELP, new RegExp(`/${cmd}`));
  }
  // Debug is intentionally documented but NOT a registered command.
  assert.ok(!names.includes("debug"));
  assert.match(ADMIN_HELP, /#debug/);
});
