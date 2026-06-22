# فضول‌خان (Fozoolkhan)

A witty Telegram bot for a small group of close friends (15–50 people). It plugs
into an LLM and behaves like a sharp, playful member of the group — quick
comebacks, friendly teasing, warm underneath. It learns a little about each
person over time so its jokes land better.

## Personality

- Playful, quick-witted, teasing the way close friends tease each other.
- Roasts the **situation and the banter**, never a person's real insecurities.
- **Never** produces sexual insults or personal humiliation aimed at real named
  people — even if asked. It deflects with a lighter, funnier joke instead.
  This is part of the character: a friend too clever to need to go low.
- Speaks primarily in **Persian (Farsi)**. (All code, comments and docs are in
  English.)

## When it talks

Only when:
- it is **mentioned** (`@fozoolkhan`), or
- someone **replies** to one of its messages.

It never responds to every message.

## The €5 promise

This bot is built to **never exceed €5/month** (configurable). Two layers
protect the budget — an AWS Budgets alert and, more importantly, an in-code
spend guard that refuses to call the LLM once the ceiling is hit (and replies
with a funny "I'm broke until next month" line in Persian instead). See
[ARCHITECTURE.md](ARCHITECTURE.md).

## How it works (high level)

```
Telegram ── webhook ──▶ Lambda (Function URL)
                          │
                          ├─ should I respond? (mention / reply)
                          ├─ spend guard (monthly counter in DynamoDB)
                          ├─ assemble context (last 4–5 msgs + person profile)
                          ├─ Amazon Bedrock (Claude Haiku)
                          └─ reply to Telegram
```

State lives in a single **DynamoDB** table (on-demand). No S3, no API Gateway —
everything stays cheap and inside AWS.

## Setup checklist

1. **Create the bot** with [@BotFather](https://t.me/BotFather); save the bot
   token. Disable privacy mode so it can see group mentions/replies.
2. **Enable Bedrock model access** for the Claude Haiku model in your AWS region.
3. **Create the DynamoDB table** (single-table, on-demand) — see
   [ARCHITECTURE.md](ARCHITECTURE.md) for keys. Enable **TTL on the `ttl`
   attribute** so append-only observations auto-expire.
4. **Deploy the Lambda** and enable a **Function URL**.
5. **Set the Telegram webhook** to the Function URL (with a secret token).
6. **Create an AWS Budget** alerting at 50/80/100% of €5.
7. Copy `config.example.js` → `config.js`, fill in constants; put secrets in
   environment variables (never commit them).

## Project docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — data model, request lifecycle, cost control.
- [AGENTS.md](AGENTS.md) — rules for AI agents working in this repo.
- [ITERATIONS.md](ITERATIONS.md) — the build, milestone by milestone.
- [BUILD_PROMPT.md](BUILD_PROMPT.md) — the prompt to run one milestone at a time.
