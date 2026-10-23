import type { Plugin, PluginContext } from "@tessar/core";
import type { LangfuseOptions } from "./types.js";
import { createTracing } from "./trace.js";
import { registerLifecycleHooks } from "./lifecycle.js";
import { registerModelHooks } from "./models.js";
import { registerToolHooks } from "./tools.js";

/** Optional Langfuse export using explicit parents and an instance-local tracer. */
export class LangfusePlugin implements Plugin {
  readonly id = "langfuse";
  readonly #options: LangfuseOptions;

  constructor(options: LangfuseOptions = {}) {
    this.#options = {
      ...options,
      tags: options.tags?.slice(),
      prompt: options.prompt ? { ...options.prompt } : undefined,
    };
  }

  setup(tessar: PluginContext): void {
    const tracing = createTracing(this.#options);
    registerLifecycleHooks(tessar, tracing);
    registerModelHooks(tessar, tracing, this.#options);
    registerToolHooks(tessar, tracing);
  }
}
