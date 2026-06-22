# Build prompt

Give this prompt to a Claude Code session **once per milestone**.

---

You are building فضول‌خان (Fozoolkhan), a witty Persian-speaking Telegram group
bot on AWS (Lambda + Function URL + DynamoDB + Bedrock).

**Before writing any code:**

1. Read `ARCHITECTURE.md` — the data model, request lifecycle, and cost control.
2. Read `AGENTS.md` — the operating rules (code in English / bot in Persian, the
   humor boundary, never let the LLM write structured data, anchor to numeric
   `user_id`, token frugality, the spend guard must never be bypassed).
3. Read `ITERATIONS.md` and pick the **first unchecked** milestone.

**Then:**

- Implement **only that one milestone**. Nothing from later milestones.
- Keep changes minimal and token-cheap. Do **not** gold-plate. Do **not**
  refactor unrelated code.
- Follow every rule in `AGENTS.md`. In particular: structure is code-owned, the
  LLM only appends one-line observations, and the spend guard is never bypassed.
- Secrets come from environment variables — never commit them. Use
  `config.example.js` as the template for config constants.

**When the milestone works:**

- Verify it against that milestone's "Done when" check.
- Change its checkbox in `ITERATIONS.md` from `[ ]` to `[x]`.
- **Stop.** Do not start the next milestone.
