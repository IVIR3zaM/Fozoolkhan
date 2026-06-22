# Architecture

## Stack (all inside AWS)

| Concern | Choice | Why |
|---|---|---|
| LLM | **Amazon Bedrock**, Claude Haiku | Cheapest model with acceptable Persian humor. Model ID is a single config constant (`BEDROCK_MODEL_ID`) so it can be swapped. |
| Compute | **AWS Lambda** + **Function URL** | Function URL, *not* API Gateway — saves cost. |
| State | **DynamoDB**, on-demand | No capacity to provision; pay per request. |
| Storage | none | No S3 needed. |

## Core principle: code owns structure, the LLM owns prose

Everything is anchored to the **numeric Telegram `user_id`** — never username or
display name. Those change; the numeric id never does. Names/usernames are just
labels that point at an id.

**Separation of responsibilities:**

- **Code** owns all *structure*: identity, the name→person mapping, probability
  weights, who-talks-to-whom edges, counters, the spend counter. The LLM never
  edits these.
- **The LLM** touches exactly **one** free-text field: a person's short
  profile/notes. And it does **not** rewrite the whole profile each turn — it
  **appends one-line observations**. A separate, occasional summarization step
  compresses observations into the profile. This stops the model from silently
  corrupting stored data.

## DynamoDB single-table design

| PK | SK | Item contents |
|---|---|---|
| `USER#<uid>` | `PROFILE` | display names seen, usernames seen, short personality summary, joke styles that land, `last_updated` |
| `USER#<uid>` | `OBS#<timestamp>` | append-only raw observation (one line). Has a **TTL** so old ones auto-expire. |
| `NAME#<name>` | `USER#<uid>` | `weight` that this spoken name refers to this person |
| `USERNAME#<username>` | `OWNER` | numeric `user_id` that currently owns this @username (1:1; lets a bare `@username` mention become an edge) |
| `EDGE#<uid_a>` | `USER#<uid_b>` | `count` of how often A talks with/about B |
| `BUDGET` | `MONTH#<YYYY-MM>` | running monthly spend estimate (see cost control) |
| `CHAT#<chatId>` | `ACCESS` | allowlist `status` (pending/approved/denied/removed) + group title (see access control) |

All writes to structured items (`NAME#`, `EDGE#`, `BUDGET`, profile structure)
are done by code. The LLM's output only ever lands in `OBS#` lines and, via the
summarization step, the free-text summary inside `PROFILE`.

## Request lifecycle

```
Telegram update
   │
   ▼
Lambda (Function URL)
   1. Verify Telegram secret token header. Reject otherwise.
   1b. ACCESS CONTROL (token guard, before any work):
        - my_chat_member (added to a group) → mark CHAT# pending, DM the admin
          approve/deny buttons. callback_query → only the admin may resolve it.
        - Private chat → answer only ADMIN_USER_ID. Group → only if its CHAT#
          ACCESS status is approved. Unauthorized → 200 OK, no record/learn/LLM.
   2. Parse update. Should we respond?
        - private chat (admin only past the gate) → always, OR
        - bot was @-mentioned, OR
        - message is a reply to one of the bot's messages.
      If not → 200 OK, do nothing.
   3. SPEND GUARD: read BUDGET / MONTH#<current> counter.
        - if over MONTHLY_BUDGET_EUR → reply with a pre-written Persian
          "broke until next month" line. DO NOT call Bedrock. Stop.
   4. Resolve the relevant person(s) (name resolution, below).
   5. Assemble context:
        - last CONTEXT_MESSAGE_COUNT (4–5) messages, and
        - the relevant person's short profile snippet.
      Keep it tight — never send full history.
   6. Call Bedrock (max_tokens capped at MAX_RESPONSE_TOKENS).
   7. Update the monthly spend counter (estimated tokens × price, or call
      count as a proxy).
   8. Reply to Telegram.
   9. Side effects (code-owned): increment NAME/EDGE weights, append an
      OBS# line, occasionally summarize observations into the profile.
```

## Cost control (two layers)

1. **AWS Budgets alert** — manual setup step. Alerts at 50/80/100% of the €5
   ceiling. This is a notification, not a brake.
2. **In-code spend guard** — the real brake. Before *every* Bedrock call, read
   the `BUDGET / MONTH#<YYYY-MM>` counter. If it is over `MONTHLY_BUDGET_EUR`,
   the bot does **not** call Bedrock; it replies with a pre-written funny
   Persian line. After each successful call, the counter is incremented by the
   estimated cost (estimated tokens × price, or call count as a proxy). The
   counter is keyed by month, so it naturally resets at month rollover.

**Token frugality everywhere:**
- Cap `max_tokens` on every response (`MAX_RESPONSE_TOKENS`).
- Send only the last 4–5 messages plus the relevant profile snippet.
- Keep profiles short; observations are one line each and TTL-expire.

## Name resolution — the "which Ali did he mean?" problem

This is the canonical example of code-owned structure helping the LLM.

1. The asker's `user_id` is always known — it's in the incoming Telegram update.
2. Query `NAME#<spoken_name>` → candidate `USER#<uid>` items with `weight`s.
3. Look up `EDGE#<asker> → USER#<uid>` for each candidate; multiply the name
   weight by the interaction count to bias toward people the asker actually
   talks with/about.
4. Decide:
   - **Confident** → read that person's `PROFILE` and answer.
   - **Ambiguous** → make the ambiguity itself the joke
     ("کدوم علی؟ همونی که…؟").
5. **Weight learning (code, not LLM):** when an `@username` appears next to a
   spoken name, or someone replies to a user and addresses them by a name,
   increment `NAME#<name> → uid`. Likewise bump `EDGE#<a> → b` when A addresses
   or replies to B. The table self-improves over time with zero LLM involvement.
