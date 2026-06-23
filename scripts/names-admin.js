#!/usr/bin/env node
// Interactive helper for curating the NAME# alias index by hand.
//
// The name->person index (NAME#<name> / USER#<uid> with a weight) is normally
// grown automatically from messages. But some links can't be derived in code — a
// Telegram name that's a Latin handle or unrelated nickname («sam» for someone
// everyone calls «حسام»). This tool lets a human inspect the current index and
// seed/repair those aliases deliberately. Three subcommands:
//
//   list                      Show every NAME# row, grouped by person, enriched
//                             with that person's PROFILE (names/usernames/summary)
//                             so you can tell who each uid is. Read-only.
//   set <alias> <uid> [opts]  Point a spoken name at a user id (idempotent: sets
//                             an absolute weight, so re-running doesn't inflate).
//   delete <name> <uid>       Remove one NAME#<name> / USER#<uid> row.
//   batch <plan.json>         Apply many set/delete ops from a JSON file, an array
//                             of {op:"set"|"delete", name, uid, weight?}. Same
//                             dry-run-unless-apply rule. Good for a reviewed plan.
//
// Writes are DRY RUN unless --apply is passed, mirroring backfill-name-tokens.js.
//
// Usage (DDB_TABLE_NAME + AWS creds/region in the environment):
//   node scripts/names-admin.js list
//   node scripts/names-admin.js set حسام 87851501 --weight 50 --apply
//   node scripts/names-admin.js delete "sam miga-macher" 87851501 --apply

import { readFileSync } from "node:fs";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

import { getProfile, normalizeName } from "../src/db.js";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const positionals = argv.filter((a) => !a.startsWith("--"));
const cmd = positionals[0];

const weightArg = () => {
  const i = argv.indexOf("--weight");
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};

const tableName = process.env.DDB_TABLE_NAME;
if (!tableName) {
  console.error("DDB_TABLE_NAME must be set in the environment.");
  process.exit(1);
}

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Pull every NAME# row (small table — a filtered Scan is fine).
const scanNameItems = async () => {
  const items = [];
  let startKey;
  do {
    const { Items, LastEvaluatedKey } = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(PK, :name)",
        ExpressionAttributeValues: { ":name": "NAME#" },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(Items ?? []));
    startKey = LastEvaluatedKey;
  } while (startKey);
  return items;
};

const listCmd = async () => {
  const rows = scanRowsToAliases(await scanNameItems());

  // Group the alias rows by the person (uid) they point at.
  const byUid = new Map();
  for (const r of rows) {
    if (!byUid.has(r.uid)) byUid.set(r.uid, []);
    byUid.get(r.uid).push(r);
  }

  console.log(`NAME# index on «${tableName}» — ${rows.length} alias row(s)\n`);
  for (const [uid, aliases] of byUid) {
    const profile = await getProfile(uid);
    const names = (profile?.names_seen ?? []).join(", ") || "—";
    const usernames = (profile?.usernames_seen ?? []).join(", ") || "—";
    console.log(`● uid=${uid}`);
    console.log(`    profile names:     ${names}`);
    console.log(`    profile usernames: ${usernames}`);
    if (profile?.summary)
      console.log(`    summary:           ${profile.summary}`);
    console.log(
      `    NAME# keys:        ${aliases
        .map((a) => `«${a.name}»(w=${a.weight})`)
        .join(", ")}`,
    );
    console.log("");
  }
};

// Map raw NAME# items to {name, uid, weight}.
const scanRowsToAliases = (items) =>
  items
    .filter((i) => String(i.SK ?? "").startsWith("USER#"))
    .map((i) => ({
      name: String(i.PK ?? "").slice("NAME#".length),
      uid: i.user_id ?? String(i.SK).slice("USER#".length),
      weight: Number(i.weight ?? 0),
    }));

// Put (not ADD) so the weight is absolute and re-running is idempotent.
const setAlias = async (alias, uid, weight) => {
  const key = normalizeName(alias);
  console.log(
    `  set    NAME#${key} → USER#${uid} (weight=${weight})${APPLY ? "" : "  [dry]"}`,
  );
  if (!APPLY) return;
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: { PK: `NAME#${key}`, SK: `USER#${uid}`, user_id: uid, weight },
    }),
  );
};

const deleteAlias = async (name, uid) => {
  const key = normalizeName(name);
  console.log(`  delete NAME#${key} / USER#${uid}${APPLY ? "" : "  [dry]"}`);
  if (!APPLY) return;
  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: `NAME#${key}`, SK: `USER#${uid}` },
    }),
  );
};

const setCmd = async () => {
  const [, alias, uid] = positionals;
  if (!alias || !uid) {
    console.error("usage: set <alias> <uid> [--weight N] [--apply]");
    process.exit(1);
  }
  console.log(`names-admin set — ${APPLY ? "APPLY" : "DRY RUN"}`);
  await setAlias(alias, uid, weightArg() ?? 5);
};

const deleteCmd = async () => {
  const [, name, uid] = positionals;
  if (!name || !uid) {
    console.error("usage: delete <name> <uid> [--apply]");
    process.exit(1);
  }
  console.log(`names-admin delete — ${APPLY ? "APPLY" : "DRY RUN"}`);
  await deleteAlias(name, uid);
};

const batchCmd = async () => {
  const planPath = positionals[1];
  if (!planPath) {
    console.error("usage: batch <plan.json> [--apply]");
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  console.log(
    `names-admin batch «${planPath}» — ${plan.length} op(s) — ${
      APPLY ? "APPLY" : "DRY RUN"
    }\n`,
  );
  for (const op of plan) {
    if (op.op === "set") await setAlias(op.name, op.uid, op.weight ?? 5);
    else if (op.op === "delete") await deleteAlias(op.name, op.uid);
    else console.error(`  ?? unknown op: ${JSON.stringify(op)}`);
  }
  console.log(
    `\nDone${APPLY ? "" : " (dry run — re-run with --apply to write)"}.`,
  );
};

const run = async () => {
  if (cmd === "list") return listCmd();
  if (cmd === "set") return setCmd();
  if (cmd === "delete") return deleteCmd();
  if (cmd === "batch") return batchCmd();
  console.error("usage: names-admin.js <list|set|delete|batch> ...");
  process.exit(1);
};

run().catch((err) => {
  console.error("names-admin failed:", err);
  process.exit(1);
});
