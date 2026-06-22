// DynamoDB access for فضول‌خان (Fozoolkhan).
//
// Milestone 3: write and read a `USER#<uid> / PROFILE` item.
//
// Code owns all structure here. Everything is anchored to the numeric Telegram
// `user_id` — never the username or display name, which are mutable labels. The
// LLM never touches these items directly (later milestones append OBS# lines and
// summarize into the free-text `summary` field; that is the only LLM-written
// field).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// One shared client per Lambda container. The table name comes from the
// environment so the same code runs against different tables (dev/prod).
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = () => process.env.DDB_TABLE_NAME;

// Primary key for a person's profile item. Anchored to the numeric user id.
const profileKey = (userId) => ({ PK: `USER#${userId}`, SK: "PROFILE" });

/**
 * Read a person's PROFILE item by numeric user id.
 *
 * @param {number|string} userId  Numeric Telegram user id.
 * @returns {Promise<object|null>} The profile item, or null if none exists.
 */
export const getProfile = async (userId) => {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: profileKey(userId) })
  );
  return Item ?? null;
};

/**
 * Record that we have seen this person, merging their current display name and
 * username into the PROFILE item. This is a code-owned, read-modify-write upsert
 * (structure only — it never writes free-text the LLM should own).
 *
 * @param {object} from  Telegram `message.from` object.
 * @returns {Promise<object>} The stored profile item.
 */
export const recordSighting = async (from) => {
  if (!from?.id) throw new Error("recordSighting: from.id is required");

  const existing = (await getProfile(from.id)) ?? {
    ...profileKey(from.id),
    user_id: from.id,
    names_seen: [],
    usernames_seen: [],
    summary: "", // free-text; owned by the LLM via later summarization step.
  };

  // Names/usernames are sets-of-strings kept deduplicated in code.
  const displayName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const names = new Set(existing.names_seen ?? []);
  if (displayName) names.add(displayName);
  const usernames = new Set(existing.usernames_seen ?? []);
  if (from.username) usernames.add(from.username);

  const item = {
    ...existing,
    user_id: from.id,
    names_seen: [...names],
    usernames_seen: [...usernames],
    last_updated: new Date().toISOString(),
  };

  await docClient.send(new PutCommand({ TableName: tableName(), Item: item }));
  return item;
};
