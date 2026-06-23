# Architecture

## Stack (all inside AWS)

| Concern | Choice                            | Why                                                                                                                           |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| LLM     | **Amazon Bedrock**, Claude Haiku  | Cheapest model with acceptable Persian humor. Model ID is a single config constant (`BEDROCK_MODEL_ID`) so it can be swapped. |
| Compute | **AWS Lambda** + **Function URL** | Function URL, _not_ API Gateway — saves cost.                                                                                 |
| State   | **DynamoDB**, on-demand           | No capacity to provision; pay per request.                                                                                    |
| Storage | none                              | No S3 needed.                                                                                                                 |

## Core principle: code owns structure, the LLM owns prose

Everything is anchored to the **numeric Telegram `user_id`** — never username or
display name. Those change; the numeric id never does. Names/usernames are just
labels that point at an id.

**Separation of responsibilities:**

- **Code** owns all _structure_: identity, the name→person mapping, probability
  weights, who-talks-to-whom edges, counters, the spend counter. The LLM never
  edits these.
- **The LLM** touches exactly **one** free-text field: a person's short
  profile/notes. And it does **not** rewrite the whole profile each turn — it
  **appends one-line observations**. A separate, occasional summarization step
  compresses observations into the profile. This stops the model from silently
  corrupting stored data.

## DynamoDB single-table design

| PK                    | SK                | Item contents                                                                                              |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `USER#<uid>`          | `PROFILE`         | display names seen, usernames seen, short personality summary, joke styles that land, `last_updated`       |
| `USER#<uid>`          | `OBS#<timestamp>` | append-only raw observation (one line). Has a **TTL** so old ones auto-expire.                             |
| `NAME#<name>`         | `USER#<uid>`      | `weight` that this spoken name refers to this person                                                       |
| `USERNAME#<username>` | `OWNER`           | numeric `user_id` that currently owns this @username (1:1; lets a bare `@username` mention become an edge) |
| `EDGE#<uid_a>`        | `USER#<uid_b>`    | `count` of how often A talks with/about B                                                                  |
| `BUDGET`              | `MONTH#<YYYY-MM>` | running monthly spend estimate (see cost control)                                                          |
| `CHAT#<chatId>`       | `ACCESS`          | allowlist `status` (pending/approved/denied/removed) + group title (see access control)                    |

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
        - Admin slash-commands (run before the gate, admin only, no Bedrock):
          /approve, /deny (alter a chat's ACCESS); /groups (list every CHAT#
          ACCESS with status + inline alter buttons); /usage (alias /credit) →
          this month's spend, ceiling, remaining, and reset date; /start, /help
          (show help). These are registered with Telegram via setMyCommands
          (scoped to the admin's DM) so the native «/» menu autocompletes them.
        - Admin debug mode: an addressed admin message containing `#debug` runs
          the normal pipeline but, instead of replying, dumps the DB inputs, the
          exact system/user prompts, and the model output for both the reply and
          a DRY-RUN summary. Nothing is persisted (no observation/summary write);
          the real Bedrock calls are still counted against the spend guard.
   2. Parse update. Should we respond?
        - private chat (admin only past the gate) → always, OR
        - bot was @-mentioned, OR
        - message is a reply to one of the bot's messages.
      If not → 200 OK, do nothing.
   3. SPEND GUARD: read BUDGET / MONTH#<current> counter.
        - if over MONTHLY_BUDGET_EUR → reply with a pre-written Persian
          "broke until next month" line. DO NOT call Bedrock. Stop.
   4. Resolve the relevant person(s) (name resolution, below). A message may name
      several people; all confidently-resolved subjects are pulled, not just the
      first. Spoken names the NAME# index didn't recognize are kept aside for the
      coreference step.
   5. Assemble context:
        - last CONTEXT_MESSAGE_COUNT (4–5) messages, and
        - a snippet about the speaker (the bot is replying to them), and
        - a separate snippet per resolved subject the speaker asked *about* (the
          summary, or recent raw observations when no summary exists yet) — framed
          so the bot answers the speaker about them, not as if addressing them, and
        - when nobody resolved, up to three unrecognized names for coreference.
      Keep it tight — never send full history.
   6. Call Bedrock (max_tokens capped at MAX_RESPONSE_TOKENS).
   7. Update the monthly spend counter (estimated tokens × price, or call
      count as a proxy).
   8. Reply to Telegram.
   9. Side effects (code-owned): increment NAME/EDGE weights, append an
      OBS# line, learn any coreference aliases the model grounded to a present
      participant (NAME# weight), occasionally summarize observations into the
      profile.
```

## Cost control (two layers)

1. **AWS Budgets alert** — manual setup step. Alerts at 50/80/100% of the €5
   ceiling. This is a notification, not a brake.
2. **In-code spend guard** — the real brake. Before _every_ Bedrock call, read
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
2. Tokenize the message and query `NAME#<spoken_name>` **per word** → candidate
   `USER#<uid>` items with `weight`s. Names are indexed one word at a time on the
   write side too, so a multi-word `first_name` («قلی گاوکش») is reachable by a
   single spoken word — the read and write sides must tokenize identically.
3. Look up `EDGE#<asker> → USER#<uid>` for each candidate; multiply the name
   weight by the interaction count to bias toward people the asker actually
   talks with/about.
4. Decide, **for every name in the message** (not just the first):
   - **Confident** → read that person's `PROFILE` and answer. Several people can
     resolve in one message; each contributes a context line.
   - **Ambiguous** → make the ambiguity itself the joke
     ("کدوم علی؟ همونی که…؟").
   - **Unrecognized** → kept for coreference (step 6).
5. **Weight learning (code, not LLM):** when an `@username` appears next to a
   spoken name, or someone replies to a user and addresses them by a name,
   increment `NAME#<name> → uid`. Likewise bump `EDGE#<a> → b` when A addresses
   or replies to B. The table self-improves over time with zero LLM involvement.

### Learning aliases the structure can't see

A person's Telegram `first_name` is arbitrary — it may be a handle unrelated to
what people call them (`Scorpion` who is always called `حسن`). No normalization can
bridge that; the link lives only in the conversation. Two layers learn it, both
keeping the structural write in **code**:

- **Layer 1 — reply-vocative (pure code).** A short reply is usually addressing
  the replied-to person by name. Each spoken-name token in it earns a _small_
  `NAME#<token> → repliedTo.id` weight. Only the real nickname recurs across many
  replies to the same id; random words scatter, so the weighted scoring filters
  them out over time.
- **Layer 2 — LLM coreference (piggybacked on the reply call).** When code
  resolves nobody, the unrecognized names are handed to the model, which — in the
  _same_ call — may map one to a person **named in the transcript** (`حسن =
Scorpion`). Code maps that label back to an id via the recent buffer's code-side
  ids (never sent to the model) and writes `NAME#حسن → id`. The model supplies
  judgment; code still owns the write.
