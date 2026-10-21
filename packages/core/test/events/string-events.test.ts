import {
  tool as toolHooks,
  stream as streamHooks,
} from "../../src/events/type.js";
import { expect, it } from "vitest";

import { PluginHost } from "../../src/plugins/host.js";
import type { Plugin } from "../../src/plugins/context.js";
it("uses string constants and a version-free plugin with tessar.hook", async () => {
  expect(toolHooks.before).toBe("tool.before");
  const seen: string[] = [];
  const plugin: Plugin = {
    id: "plain",
    setup(tessar) {
      tessar.hook(streamHooks.started, (event) => {
        seen.push(event.type);
      });
    },
  };
  const host = new PluginHost();
  await host.initialize([plugin]);
  await host.dispatch(streamHooks.started, {
    modelRef: { providerId: "p", modelId: "m" },
    checkpointId: "c",
  });
  expect(seen).toEqual(["stream.started"]);
  await host.dispose();
});
