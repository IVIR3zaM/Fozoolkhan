#!/usr/bin/env node
// One-off backfill: re-index multi-word NAME# rows per word.
//
// Background: name resolution looks names up one whitespace-delimited word at a
// time, but older data stored a person's whole (possibly multi-word) first_name
// or mention label as a single NAME# partition key — e.g. `NAME#sam miga-macher`.
// Such a key can never be hit by a single spoken token, so the person is
// unresolvable. This script finds those rows and re-indexes each word as its own
// `NAME#<word> → USER#<uid>` weight, mirroring what learnFromMessage now does
// going forward (see src/names.js `nameTokens`).
//
// Usage (DDB_TABLE_NAME and AWS creds/region must be in the environment):
//   node scripts/backfill-name-tokens.js                # dry run (default) — prints what it would do
//   node scripts/backfill-name-tokens.js --apply        # write the per-word rows
//   node scripts/backfill-name-tokens.js --apply --delete-old
//                                                        # also remove the old multi-word rows
//
// NOT idempotent without --delete-old: re-running --apply adds the weight again.
// Run it once with --apply --delete-old (deleting the old rows means a second run
// finds nothing to do).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

import { bumpNameWeight } from "../src/db.js";
import { nameTokens } from "../src/names.js";

const APPLY = process.argv.includes("--apply");
const DELETE_OLD = process.argv.includes("--delete-old");

const tableName = process.env.DDB_TABLE_NAME;
if (!tableName) {
  console.error("DDB_TABLE_NAME must be set in the environment.");
  process.exit(1);
}

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Pull every NAME# item (the table is small — a filtered Scan is fine, same as
// the admin /groups overview does for ACCESS items).
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

const run = async () => {
  console.log(
    `Backfill name tokens on «${tableName}» — ${
      APPLY ? "APPLY" : "DRY RUN"
    }${DELETE_OLD ? " (+delete old rows)" : ""}\n`,
  );

  const items = await scanNameItems();
  let multiWord = 0;
  let tokensWritten = 0;

  for (const item of items) {
    const pk = String(item.PK ?? "");
    const sk = String(item.SK ?? "");
    const name = pk.slice("NAME#".length);

    // Only multi-word keys need fixing; single-word rows are already correct.
    if (!/\s/.test(name)) continue;
    if (!sk.startsWith("USER#")) continue;

    const uid = item.user_id ?? sk.slice("USER#".length);
    const weight = Number(item.weight ?? 0);
    const tokens = nameTokens(name);
    if (!uid || !tokens.length) continue;

    multiWord += 1;
    console.log(
      `«${name}» (uid=${uid}, weight=${weight}) → ${tokens.join(", ")}`,
    );

    if (APPLY) {
      for (const token of tokens) {
        // Preserve the accumulated weight on each per-word key.
        await bumpNameWeight(token, uid, weight || 1);
        tokensWritten += 1;
      }
      if (DELETE_OLD) {
        await docClient.send(
          new DeleteCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }),
        );
      }
    }
  }

  console.log(
    `\nDone. ${multiWord} multi-word row(s) found` +
      (APPLY
        ? `; ${tokensWritten} per-word weight(s) written${
            DELETE_OLD ? `; ${multiWord} old row(s) deleted` : ""
          }.`
        : ". Re-run with --apply to write."),
  );
};

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
