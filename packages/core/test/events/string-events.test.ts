import { expect, it } from "vitest";
import { AgentEvents } from "../../src/events/catalog.js";
import { PluginHost } from "../../src/plugins/host.js";
import type { Plugin } from "../../src/plugins/context.js";
it("uses string constants and a version-free plugin with tessar.hook", async () => {
  expect(AgentEvents.BeforeTool).toBe("tool.before");
  const seen: string[] = [];
  const plugin: Plugin = {
    id: "plain",
    setup(tessar) {
      tessar.hook(AgentEvents.StreamStarted, (event) => {
        seen.push(event.type);
      });
    },
  };
  const host = new PluginHost();
  await host.initialize([plugin]);
  await host.dispatch(AgentEvents.StreamStarted, {
    modelRef: { providerId: "p", modelId: "m" },
    checkpointId: "c",
  });
  expect(seen).toEqual(["stream.started"]);
  await host.dispose();
});
