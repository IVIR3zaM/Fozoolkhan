// Tests for the model price catalog: matching a configured model id to its price
// family, the per-1K conversion, and the fallback for unknown models. This is
// what makes the spend estimate and the /usage comparison track the chosen model.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_CATALOG,
  catalogEntryFor,
  pricePer1k,
  priceForModel,
  projectCost,
} from "../src/pricing.js";

beforeEach(() => {
  // Pin the FX factor and clear any price overrides so the math is deterministic.
  process.env.USD_TO_EUR = "0.92";
  delete process.env.BEDROCK_INPUT_PRICE_PER_1K_EUR;
  delete process.env.BEDROCK_OUTPUT_PRICE_PER_1K_EUR;
});

test("catalogEntryFor: resolves the EU inference-profile id to its family", () => {
  const haiku = catalogEntryFor("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(haiku.label, "Claude Haiku 4.x");

  const sonnet = catalogEntryFor("eu.anthropic.claude-sonnet-4-6-v1:0");
  assert.equal(sonnet.key, "sonnet-4");

  const opus = catalogEntryFor("anthropic.claude-opus-4-8");
  assert.equal(opus.key, "opus-4");
});

test("catalogEntryFor: null for a model the catalog doesn't know", () => {
  assert.equal(catalogEntryFor("gpt-some-thing"), null);
  assert.equal(catalogEntryFor(undefined), null);
});

test("pricePer1k: applies the USD→EUR factor to the list price", () => {
  const haiku = MODEL_CATALOG.find((m) => m.key === "haiku-4");
  const { inPer1k, outPer1k } = pricePer1k(haiku);
  // $1/M → 0.00092 EUR/1K, $5/M → 0.0046 EUR/1K, at 0.92.
  assert.ok(Math.abs(inPer1k - 0.00092) < 1e-9);
  assert.ok(Math.abs(outPer1k - 0.0046) < 1e-9);
});

test("priceForModel: known model prices from the catalog", () => {
  const { inPer1k, outPer1k } = priceForModel("eu.anthropic.claude-opus-4-8");
  // $5/$25 per M at 0.92.
  assert.ok(Math.abs(inPer1k - 0.0046) < 1e-9);
  assert.ok(Math.abs(outPer1k - 0.023) < 1e-9);
});

test("priceForModel: unknown model falls back to the default Haiku rate", () => {
  const { inPer1k, outPer1k } = priceForModel("mystery-model");
  assert.ok(Math.abs(inPer1k - 0.00092) < 1e-9);
  assert.ok(Math.abs(outPer1k - 0.0046) < 1e-9);
});

test("priceForModel: explicit env price overrides only the unknown-model path", () => {
  process.env.BEDROCK_INPUT_PRICE_PER_1K_EUR = "0.01";
  process.env.BEDROCK_OUTPUT_PRICE_PER_1K_EUR = "0.02";
  // Unknown model → env fallback wins.
  assert.equal(priceForModel("mystery-model").inPer1k, 0.01);
  // Known model → catalog still wins, env ignored.
  assert.ok(
    Math.abs(priceForModel("anthropic.claude-haiku-4-5").inPer1k - 0.00092) <
      1e-9,
  );
});

test("projectCost: euro cost from token counts on a catalog entry", () => {
  const sonnet = MODEL_CATALOG.find((m) => m.key === "sonnet-4");
  // 1M input * 0.00276 + 200K output * 0.0138 = 2.76 + 2.76 = 5.52.
  const cost = projectCost(sonnet, 1_000_000, 200_000);
  assert.ok(Math.abs(cost - 5.52) < 1e-6);
});
