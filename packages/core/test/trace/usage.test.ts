import { expect, it } from "vitest";
import { aggregateUsage, normalizeUsage } from "../../src/trace/usage.js";
it("aggregates distinct attempts without adding cache or reasoning subsets again", () => {
  const result = aggregateUsage([
    {
      id: "a",
      usage: normalizeUsage({
        inputTokens: 100,
        outputTokens: 30,
        cacheReadInputTokens: 40,
        reasoningOutputTokens: 10,
      }),
    },
    {
      id: "a",
      usage: normalizeUsage({
        inputTokens: 100,
        outputTokens: 30,
        cacheReadInputTokens: 40,
        reasoningOutputTokens: 10,
      }),
    },
    { id: "b", usage: normalizeUsage({ outputTokens: 5 }) },
  ]);
  expect(result.metrics.outputTokens).toEqual({
    knownTotal: 35,
    knownAttempts: 2,
    totalAttempts: 2,
    coverage: "complete",
  });
  expect(result.metrics.inputTokens).toEqual({
    knownTotal: 100,
    knownAttempts: 1,
    totalAttempts: 2,
    coverage: "partial",
  });
  expect(result.metrics.totalTokens.knownTotal).toBe(130);
  expect(result.metrics.totalTokens.coverage).toBe("partial");
});
it("replaces cumulative attempt updates and keeps unavailable counts unknown", () => {
  const result = aggregateUsage([
    { id: "a", usage: normalizeUsage({ outputTokens: 2 }) },
    { id: "a", usage: normalizeUsage({ outputTokens: 7 }) },
  ]);
  expect(result.metrics.outputTokens.knownTotal).toBe(7);
  expect(result.metrics.inputTokens.knownTotal).toBeNull();
  expect(result.metrics.inputTokens.coverage).toBe("unavailable");
  expect(aggregateUsage([]).metrics.totalTokens.knownTotal).toBe(0);
  expect(() => normalizeUsage({ inputTokens: -1 })).toThrow();
});
