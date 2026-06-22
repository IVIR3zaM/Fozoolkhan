# Build milestones

Build in this order. Each milestone is small enough to implement and verify in
one short session. Implement **one per run**, then tick its box and stop.

Mark done by changing `[ ]` to `[x]`.

---

- [ ] **(1) Lambda + Function URL echoing the webhook**
  Deploy a Lambda with a Function URL that accepts a Telegram webhook POST,
  parses the update, and returns `200`. Log the parsed update.
  **Done when:** a real Telegram message to the bot hits the Lambda and the
  update appears in CloudWatch logs.

- [ ] **(2) Respond only on mention / reply**
  Detect whether the bot was `@`-mentioned or replied to. Ignore everything
  else (still return `200`).
  **Done when:** the bot reacts only to mentions/replies and stays silent
  otherwise.

- [ ] **(3) DynamoDB table + write/read a profile**
  Create/connect the single table. Write and read a `USER#<uid> / PROFILE` item.
  **Done when:** a profile item can be written and read back by `user_id`.

- [ ] **(4) Bedrock call with personality system prompt**
  Call Claude Haiku via Bedrock with the Persian personality system prompt and
  reply to the triggering message. `max_tokens` capped.
  **Done when:** the bot replies in-character in Persian to a mention.

- [ ] **(5) Context assembly**
  Send the last `CONTEXT_MESSAGE_COUNT` (4–5) messages + the person's profile
  snippet, nothing more.
  **Done when:** replies reflect recent context and the relevant profile, with
  no full-history payloads.

- [ ] **(6) Spend guard + monthly counter**
  Read `BUDGET / MONTH#<YYYY-MM>` before each call; block + Persian "broke" line
  when over `MONTHLY_BUDGET_EUR`; increment after each call; reset by month key.
  **Done when:** forcing the counter over the ceiling makes the bot decline with
  the funny line and skip Bedrock; the counter increments on real calls.

- [ ] **(7) Name resolution + weights**
  Query `NAME#<name>`, bias by `EDGE#<asker>`, answer when confident, joke when
  ambiguous. Code learns weights from `@username`/reply addressing.
  **Done when:** the bot resolves a name to the right person, or makes the
  ambiguity the joke; weights update over time.

- [ ] **(8) Append-only observations + summarization**
  Append one-line `OBS#<ts>` items (with TTL). A separate occasional step
  compresses observations into the profile summary.
  **Done when:** observations accumulate and a summarization run folds them into
  the profile without the LLM rewriting structured fields.

- [ ] **(9) Edge learning**
  Increment `EDGE#<a> → b` when A addresses/replies to B.
  **Done when:** repeated interactions raise the edge count and measurably bias
  name resolution.
