import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBundledCapabilityRegistry } from "../src/catalog.js";

describe("Command Code bundled capability registry", () => {
  it("extracts per-model reasoning, context, and text-only metadata", () => {
    const source = [
      'a=["low","medium","high","xhigh","max"],b=["low","medium","high","xhigh"],',
      'effortMap=new Map([["meta/muse-spark-1.3",a],["meta/muse-spark-1.3-contributor",b]]),',
      'contextMap=new Map([["meta/muse-spark-1.3",1048576],["meta/muse-spark-1.3-contributor",1048576]]),',
      'knownModels=new Set(["meta/muse-spark-1.3","meta/muse-spark-1.3-contributor"]),',
      'textOnly=new Set(["deepseek/deepseek-v4-pro","meta/muse-spark-1.3-contributor"]),',
    ].join("");

    assert.deepEqual(parseBundledCapabilityRegistry(source), {
      "meta/muse-spark-1.3": {
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        contextWindow: 1048576,
        supportsVision: true,
      },
      "meta/muse-spark-1.3-contributor": {
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        contextWindow: 1048576,
        supportsVision: false,
      },
    });
  });

  it("fails closed when the installed bundle has no recognizable registry", () => {
    assert.deepEqual(parseBundledCapabilityRegistry("const unrelated = 1;"), {});
  });
});
