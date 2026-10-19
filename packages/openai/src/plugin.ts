import type { Plugin, PluginContext } from "@tessar/core";
import { OpenAIAdapter, createClient, type OpenAIOptions } from "./adapter.js";
import { metadataResolver } from "./metadata.js";
export class OpenAIPlugin implements Plugin {
  readonly id: string;
  private readonly providerId: string;
  private readonly options: OpenAIOptions;

  constructor(options: OpenAIOptions) {
    this.options = options;
    this.providerId = options.providerId ?? "openai";
    this.id = "provider." + this.providerId;
  }

  setup(tessar: PluginContext): void {
    const options = this.options, id = this.providerId;
    const client = createClient(options);
    tessar.models.register({
      id,
      endpoint: options.baseURL ?? "https://api.openai.com/v1",
      metadataPartition: options.metadataPartition,
      metadata: metadataResolver(client),
      catalogModelRef: (ref) =>
        !options.baseURL ||
        options.baseURL.replace(/\/$/, "") === "https://api.openai.com/v1"
          ? { providerId: "openai", modelId: ref.modelId }
          : null,
      catalogMappingVersion: 1,
      create: (modelId) =>
        new OpenAIAdapter(options, { providerId: id, modelId }, client),
    });
  }
}
