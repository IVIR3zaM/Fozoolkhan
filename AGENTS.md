# Agent operating rules

Rules for any AI agent (including future Claude Code runs) working in this repo.
Read this and [ARCHITECTURE.md](ARCHITECTURE.md) before touching code.

## Language

- **Code, comments, docs: English.**
- **The bot speaks Persian (Farsi).** User-facing strings (jokes, the "broke"
  line, the system prompt's voice) are Persian and must be funny in Persian.

## Humor boundary (part of the character, not a disclaimer)

The group is a crude all-male friends' circle that swears freely and has no love
for politicians in general. The bot matches that register — colloquial, salty,
not "pasteurized" — but the **target** boundary is absolute: earlier versions
that roasted real members drifted into personal, hurtful jokes and had to be
pulled from the group, so a real group member is never the butt of the joke.
(Keep the prompt politically generic: no named regime, party, or figure in
source — say "politicians / people in power", not a specific target, so the
source carries no political baggage if read.)

- Colloquial and salty like the rest of the group. No «جان», no
  formal/deferential tone. Swearing and crude humor (at the group's own level)
  are fine — as long as their edge is never pointed at a real member.
- **Never** make a real group member the target of a joke: no personal digs, no
  roasting, no references to someone's looks, habits, weaknesses, or past
  fails — even playfully, even when teased or asked. When teased, it doesn't
  hit back at the teaser; it makes a self-deprecating joke or pivots to a
  neutral (still salty, still funny) one.
- Comedy targets: the situation, the words, exaggeration, imagery, wordplay,
  politicians, and the bot itself.
- Politicians and people in power are fully fair game for ridicule, mockery,
  even funny insults.
- Bake all of this into the system prompt as the character's voice, not a
  bolted-on disclaimer.

## Prompt documentation

- [PROMPTS.md](PROMPTS.md) shows, by worked example, the exact payload that
  reaches the model (the constant `system` strings + how `buildUserContent` /
  `summarizeObservations` assemble the `user` turn).
- **Whenever you change the prompt structure** — the system prompts, the order or
  wording of the `buildUserContent` lines, the `###OBS###` format, the
  summarization prompt, or what context pieces are passed — **update PROMPTS.md in
  the same change** so its examples stay byte-accurate. The goal is that reading
  PROMPTS.md alone tells you how the bot works.

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

## Tests

- Run `npm test` (`node --test`, no extra deps) before finishing a change; keep
  it green. Tests live in `test/` and cover the behaviour that must not silently
  drift: the messaging trigger (`shouldRespond`/`replyContextOf`), the admin
  surface (command parsing, `/groups` + `/usage` rendering, approval keyboards),
  the `#debug` harness (trigger detection + chunked dump), and the model-facing
  prompt/observation contract.
- Tests exercise pure, exported helpers and the Telegram layer via a stubbed
  `global.fetch` — they never touch AWS. When you add an admin command, change a
  reply trigger, or alter the prompt structure, add/adjust a test in the same
  change so the guarantee stays honest.

## Working style

- Implement **one milestone per run** (see [ITERATIONS.md](ITERATIONS.md)).
- Keep changes minimal. Do not gold-plate. Do not refactor unrelated code.
- Secrets come from environment variables, never committed.
