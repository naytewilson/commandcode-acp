// Fixture copy of the Command Code bundled capability shape, for
// effort-config tests only. The bridge reads (never executes) the cli.mjs
// next to the cmd binary; this fixture stands in for the real bundle so
// tests can prove fallback-model reasoning without network or LLM.
const REASONING_TIERS = ["low", "high"];
export const MODEL_REASONING = new Map([
  ["meta/muse-spark-1.3-test", REASONING_TIERS],
]);
