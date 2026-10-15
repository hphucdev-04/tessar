import type { ProfilePatch, ModelPricing } from "./profile.js";
import type { CatalogSnapshot } from "./catalog.js";
export function normalizeCatalog(
  source: unknown,
  identity: { revision: string; fetchedAt: string },
): CatalogSnapshot {
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw Error("Invalid model catalog");
  const entries: CatalogSnapshot["entries"] = {};
  const positive = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null;
  const rate = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const capability = (value: unknown) =>
    typeof value === "boolean" ? value : null;
  for (const [providerId, provider] of Object.entries(
    source as Record<string, any>,
  )) {
    if (
      !provider ||
      typeof provider !== "object" ||
      !provider.models ||
      typeof provider.models !== "object"
    )
      continue;
    const models: Record<string, ProfilePatch> = {};
    for (const [modelId, value] of Object.entries(provider.models)) {
      const model = value as any;
      if (!model || typeof model !== "object") continue;
      const cost = model.cost,
        conditions: NonNullable<ModelPricing["tiers"]>[number][] = [];
      if (cost?.context_over_200k)
        conditions.push({
          condition: { contextTokens: { gt: 200000 } },
          rates: cost.context_over_200k,
        });
      if (cost?.tiers)
        conditions.push(
          ...(Array.isArray(cost.tiers)
            ? cost.tiers
            : Object.entries(cost.tiers)
          ).map((tier: unknown, index: number) => ({
            condition: { source: "models.dev", tier: index },
            rates: tier as any,
          })),
        );
      if (cost?.input_audio !== undefined || cost?.output_audio !== undefined)
        conditions.push({
          condition: { modality: "audio" },
          rates: Object.fromEntries(
            Object.entries({
              input: cost.input_audio,
              output: cost.output_audio,
            }).filter(([, v]) => v !== undefined),
          ) as any,
        });
      models[modelId] = {
        name: typeof model.name === "string" ? model.name : null,
        contextWindow: positive(model.limit?.context),
        maxInputTokens: positive(model.limit?.input),
        maxOutputTokens: positive(model.limit?.output),
        capabilities: {
          tools: capability(model.tool_call),
          reasoning: capability(model.reasoning),
          structuredOutput: capability(model.structured_output),
          imageInput: Array.isArray(model.modalities?.input)
            ? model.modalities.input.includes("image")
            : null,
          audioInput: Array.isArray(model.modalities?.input)
            ? model.modalities.input.includes("audio")
            : null,
          audioOutput: Array.isArray(model.modalities?.output)
            ? model.modalities.output.includes("audio")
            : null,
        },
        pricing: cost
          ? {
              currency: "USD",
              basis: "million-tokens",
              type: conditions.length ? "tiered" : "flat",
              input: rate(cost.input),
              output: rate(cost.output),
              cacheRead: rate(cost.cache_read),
              cacheWrite: rate(cost.cache_write),
              reasoning: rate(cost.reasoning),
              ...(conditions.length ? { tiers: conditions } : {}),
            }
          : null,
      };
    }
    entries[providerId] = models;
  }
  if (!Object.keys(entries).length)
    throw Error("Catalog contains no providers");
  return { ...identity, source: "https://models.dev/api.json", entries };
}
