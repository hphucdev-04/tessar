import type OpenAI from "openai";
import type { MetadataResolver } from "@tesseract/core";
export function metadataResolver(client: OpenAI): MetadataResolver {
  return {
    async resolve(ref, options) {
      await client.models.retrieve(ref.modelId, { signal: options.signal });
      return {};
    },
  };
}
