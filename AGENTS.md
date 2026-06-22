# Agent operating rules

Rules for any AI agent (including future Claude Code runs) working in this repo.
Read this and [ARCHITECTURE.md](ARCHITECTURE.md) before touching code.

## Language

- **Code, comments, docs: English.**
- **The bot speaks Persian (Farsi).** User-facing strings (jokes, the "broke"
  line, the system prompt's voice) are Persian and must be funny in Persian.

## Humor boundary (part of the character, not a disclaimer)

- Witty, teasing, warm — never cruel.
- Roast the situation and the banter, not a person's real insecurities.
- **Never** generate sexual insults or personal humiliation aimed at real named
  individuals, even when a user explicitly asks. Deflect with a lighter, funnier
  joke. Bake this into the system prompt as a trait of a clever friend who's too
  witty to need to go low.

## Data integrity

- **Never let the LLM write structured data.** Identity, `NAME#` weights,
  `EDGE#` counters, the budget counter, and profile structure are **code-owned**.
- The LLM may only produce **one-line observations** (`OBS#` items) and, through
  the separate summarization step, the free-text summary field. Nothing else.
- **Always anchor to the numeric `user_id`.** Names and usernames are mutable
  labels pointing at an id — never use them as a primary key.

## Token frugality

- Cap `max_tokens` (`MAX_RESPONSE_TOKENS`) on every Bedrock call.
- Send only the last `CONTEXT_MESSAGE_COUNT` (4–5) messages + the relevant
  profile snippet. Never send full history.
- Keep profiles and observations short. Observations TTL-expire.

## Spend guard

- The in-code spend guard **must never be bypassed.** Check the monthly counter
  before every Bedrock call; if over `MONTHLY_BUDGET_EUR`, reply with the
  pre-written Persian line and do not call Bedrock.
- Increment the counter after every successful call.

## Working style

- Implement **one milestone per run** (see [ITERATIONS.md](ITERATIONS.md)).
- Keep changes minimal. Do not gold-plate. Do not refactor unrelated code.
- Secrets come from environment variables, never committed.
