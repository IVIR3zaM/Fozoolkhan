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
  renderModelComparison,
  renderUserList,
  renderUserContext,
  USERS_EMPTY,
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

test("renderUsage: appends the model comparison table", () => {
  const text = renderUsage(1.5, 5, { inputTokens: 1_000_000, outputTokens: 0 });
  assert.match(text, /DeepSeek v3\.2/);
  assert.match(text, /Claude Haiku 4\.x/);
  assert.match(text, /Claude Sonnet 4\.x/);
  assert.match(text, /Claude Opus 4\.x/);
});

test("renderModelComparison: token fallback only when nothing has been spent", () => {
  process.env.USD_TO_EUR = "0.92"; // pin FX so the numbers are deterministic
  // No spend yet → fall back to tokens. 1M in + 200K out: Haiku 1.84, Sonnet
  // 5.52 (+3.68), Opus 9.20 (+7.36).
  const text = renderModelComparison(
    0,
    1_000_000,
    200_000,
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
  assert.match(text, /Claude Haiku 4\.x — \$1\/\$5.*الان ✅/);
  assert.match(text, /1\.84 یورو/); // current projected cost
  assert.match(text, /5\.52 یورو \(\+3\.68/); // sonnet, dearer
  assert.match(text, /9\.20 یورو \(\+7\.36/); // opus, dearest
  assert.match(text, /بر پایه‌ی توکنِ این ماه/); // token basis surfaced
});

test("renderModelComparison: prefers exact token pricing when token totals exist", () => {
  process.env.USD_TO_EUR = "0.92";
  const text = renderModelComparison(
    0.17,
    1_000_000,
    200_000,
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
  assert.match(text, /Claude Haiku 4\.x — \$1\/\$5.*1\.84 یورو \(الان ✅\)/);
  assert.match(text, /DeepSeek v3\.2 — \$0\.62\/\$1\.85.*0\.91 یورو/);
  assert.match(text, /Claude Sonnet 4\.x — \$3\/\$15.*5\.52 یورو/);
  assert.match(text, /بر پایه‌ی توکنِ این ماه/);
});

test("renderModelComparison: scales the real spend when no tokens are recorded", () => {
  // The real-world case: spend exists but token totals predate token tracking.
  // 0.16 € on Haiku → Sonnet 0.48 (+0.32, 3×), Opus 0.80 (+0.64, 5×).
  const text = renderModelComparison(
    0.16,
    0,
    0,
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
  assert.match(text, /Claude Haiku 4\.x.*0\.16 یورو \(الان ✅\)/);
  assert.match(text, /0\.48 یورو \(\+0\.32/); // sonnet, 3×
  assert.match(text, /0\.80 یورو \(\+0\.64/); // opus, 5×
  assert.match(text, /بر پایه‌ی خرجِ واقعیِ این ماه \(0\.16 یورو\)/);
});

test("renderModelComparison: no current mark when the model is unknown", () => {
  const text = renderModelComparison(1, 1000, 1000, "some-other-model");
  assert.doesNotMatch(text, /الان ✅/);
  assert.doesNotMatch(text, /نسبت به الان/); // no deltas without a current baseline
});

test("renderUserList: one line per user with id, name, handle, summary", () => {
  const text = renderUserList([
    {
      PK: "USER#87851501",
      names_seen: ["حسام"],
      usernames_seen: ["hesam"],
      summary: "اهل طنزِ سیاسی",
    },
    { PK: "USER#42", names_seen: ["رضا"] },
  ]);
  assert.match(text, /2 نفر/);
  assert.match(text, /87851501 — حسام \(@hesam\) — اهل طنزِ سیاسی/);
  assert.match(text, /42 — رضا/);
  assert.match(text, /\/user </); // points the admin at the detail command
});

test("renderUserList: empty state when nobody is stored", () => {
  assert.equal(renderUserList([]), USERS_EMPTY);
});

test("renderUserContext: dumps profile, observations, aliases and edges", () => {
  const text = renderUserContext({
    uid: "87851501",
    profile: {
      names_seen: ["حسام", "Hesam"],
      usernames_seen: ["hesam"],
      summary: "اهل طنزِ سیاسی",
      last_updated: "2026-06-23T10:00:00.000Z",
    },
    observations: ["همیشه دیر میاد", "عاشق فوتباله"],
    aliases: [{ name: "سام", weight: 3 }],
    edges: [{ label: "رضا", count: 5 }],
  });
  assert.match(text, /کاربر 87851501/);
  assert.match(text, /نام‌ها: حسام، Hesam/);
  assert.match(text, /یوزرنیم‌ها: @hesam/);
  assert.match(text, /خلاصه: اهل طنزِ سیاسی/);
  assert.match(text, /یادداشت‌ها \(2\)/);
  assert.match(text, /• همیشه دیر میاد/);
  assert.match(text, /• سام \(وزن 3\)/);
  assert.match(text, /• رضا \(×5\)/);
});

test("renderUserContext: graceful when nothing is stored for the user", () => {
  const text = renderUserContext({ uid: "999", profile: null });
  assert.match(text, /پروفایلی براش ذخیره نشده/);
  assert.match(text, /یادداشت‌ها \(0\)/);
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
