// Model price catalog for فضول‌خان (Fozoolkhan).
//
// One place that knows what each Claude model costs, so two things stay in sync:
//   1. the live spend estimate (bedrock.js prices each call by the configured
//      model id — change BEDROCK_MODEL_ID and the counter re-prices automatically), and
//   2. the admin `/usage` comparison table (what this month's *actual* token
//      usage would have cost on every other model — see renderModelComparison).
//
// Prices are Anthropic's published list rates in USD per million tokens. Amazon
// Bedrock bills Claude at those same rates, and a cross-region inference profile
// (the `eu.anthropic.*` ids we run in Frankfurt) adds no surcharge — tokens are
// billed at the base per-token price. The euro figures the rest of the code uses
// are these USD rates times USD_TO_EUR.

// USD→EUR factor applied to every price. A single knob so the estimate tracks the
// exchange rate without editing per-model numbers. Override via env if the rate
// drifts; ~0.92 means 1 USD ≈ 0.92 EUR (EUR/USD ≈ 1.087).
export const usdToEur = () => Number(process.env.USD_TO_EUR ?? 0.92);

// The Claude families we can realistically point the bot at on Bedrock, with
// their list prices (USD per million tokens). `key` is matched as a substring of
// the configured model id, so the EU inference-profile ids resolve without
// hardcoding the full string (e.g. "eu.anthropic.claude-haiku-4-5-…" → haiku-4).
// Prices reflect the current 4.x generation (Haiku 4.5 / Sonnet 4.6 / Opus 4.8).
export const MODEL_CATALOG = [
  { key: "haiku-4", label: "Claude Haiku 4.x", usdInPerM: 1, usdOutPerM: 5 },
  { key: "sonnet-4", label: "Claude Sonnet 4.x", usdInPerM: 3, usdOutPerM: 15 },
  { key: "opus-4", label: "Claude Opus 4.x", usdInPerM: 5, usdOutPerM: 25 },
];

/**
 * EUR price per 1K tokens for a catalog entry (input and output), applying the
 * current USD→EUR factor.
 *
 * @param {{usdInPerM: number, usdOutPerM: number}} entry
 * @returns {{inPer1k: number, outPer1k: number}}
 */
export const pricePer1k = (entry) => {
  const fx = usdToEur();
  return {
    inPer1k: (entry.usdInPerM / 1000) * fx,
    outPer1k: (entry.usdOutPerM / 1000) * fx,
  };
};

/**
 * Find the catalog entry whose family key appears in the model id, or null if the
 * model isn't one we have a price for.
 *
 * @param {string} modelId  The configured Bedrock model / inference-profile id.
 * @returns {object|null}
 */
export const catalogEntryFor = (modelId) =>
  MODEL_CATALOG.find((m) => String(modelId ?? "").includes(m.key)) ?? null;

/**
 * EUR per-1K prices for the configured model. Resolves from the catalog by model
 * id; for an unrecognized model it falls back to the explicit price env vars
 * (BEDROCK_INPUT/OUTPUT_PRICE_PER_1K_EUR), then to Claude Haiku 4.5's rate. This
 * is what makes changing BEDROCK_MODEL_ID alone re-price the spend counter.
 *
 * @param {string} modelId
 * @returns {{inPer1k: number, outPer1k: number}}
 */
export const priceForModel = (modelId) => {
  const entry = catalogEntryFor(modelId);
  if (entry) return pricePer1k(entry);
  return {
    inPer1k: Number(process.env.BEDROCK_INPUT_PRICE_PER_1K_EUR ?? 0.00092),
    outPer1k: Number(process.env.BEDROCK_OUTPUT_PRICE_PER_1K_EUR ?? 0.0046),
  };
};

/**
 * Estimated EUR cost of a number of input/output tokens on a catalog entry.
 *
 * @param {{usdInPerM: number, usdOutPerM: number}} entry
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
export const projectCost = (entry, inputTokens, outputTokens) => {
  const { inPer1k, outPer1k } = pricePer1k(entry);
  return (
    ((Number(inputTokens) || 0) / 1000) * inPer1k +
    ((Number(outputTokens) || 0) / 1000) * outPer1k
  );
};
