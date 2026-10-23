import { expect, it } from "vitest";
import { Agent, Controller } from "../src/index.js";
import { PluginHost } from "../src/plugins/host.js";

const model = { providerId: "test", modelId: "test" };

it("rejects duplicate live Agent IDs and releases them after shutdown", async () => {
  const agent = new Agent({ id: "duplicate-agent", model });
  expect(() => new Agent({ id: agent.id, model })).toThrowError(
    expect.objectContaining({ code: "RegistrationConflict" }),
  );
  await agent.shutdown();
  const replacement = new Agent({ id: agent.id, model });
  await agent.shutdown();
  expect(() => new Agent({ id: agent.id, model })).toThrow();
  await replacement.shutdown();
});

it("does not reserve IDs for invalid Agents", async () => {
  expect(
    () => new Agent({ id: "invalid-agent", model, limits: { maxTurns: 0 } }),
  ).toThrow();
  const agent = new Agent({ id: "invalid-agent", model });
  await agent.shutdown();
});

it("rejects duplicate Controller IDs without binding the candidate Agent", async () => {
  const controller = new Controller({
    id: "duplicate-controller",
    agent: new Agent({ id: "duplicate-controller", model }),
  });
  const candidate = new Agent({ id: "candidate", model });
  expect(
    () => new Controller({ id: controller.id, agent: candidate }),
  ).toThrowError(expect.objectContaining({ code: "RegistrationConflict" }));
  await controller.dispose();
  const replacement = new Controller({ id: controller.id, agent: candidate });
  await controller.dispose();
  const unused = new Agent({ id: "unused-candidate", model });
  expect(() => new Controller({ id: controller.id, agent: unused })).toThrow();
  await unused.shutdown();
  await replacement.dispose();
});

it("does not reserve Controller IDs when binding fails", async () => {
  const owner = new Controller({
    id: "owner",
    agent: new Agent({ id: "bound", model }),
  });
  expect(
    () => new Controller({ id: "failed-binding", agent: owner.agent }),
  ).toThrow();
  const controller = new Controller({
    id: "failed-binding",
    agent: new Agent({ id: "unbound", model }),
  });
  await controller.dispose();
  await owner.dispose();
});

it("registers plugin Agents and retains them until captured work releases the plugin", async () => {
  const host = new PluginHost();
  const agent = new Agent({ id: "plugin-agent", model });
  await host.attach({
    id: "worker",
    setup(tessar) {
      tessar.agent.register(agent);
    },
  });
  const lease = host.capture();
  expect(lease.find("agent", agent.id)).toBe(agent);
  await host.detach("worker");
  expect(host.registrations()).toEqual([]);
  expect(() => new Agent({ id: agent.id, model })).toThrow();
  await lease.release();
  const replacement = new Agent({ id: agent.id, model });
  await replacement.shutdown();
  await host.dispose();
});

it("rolls back registered Agents when plugin setup fails", async () => {
  const host = new PluginHost();
  await expect(
    host.attach({
      id: "broken",
      setup(tessar) {
        tessar.agent.register(new Agent({ id: "rolled-back", model }));
        throw new Error("setup failed");
      },
    }),
  ).rejects.toThrow("setup failed");
  expect(host.registrations()).toEqual([]);
  const replacement = new Agent({ id: "rolled-back", model });
  await replacement.shutdown();
  await host.dispose();
});

it("includes the configured Agent in the Controller registry and rejects duplicate registration", async () => {
  const agent = new Agent({ id: "configured", model });
  const controller = new Controller({
    id: "configured",
    agent,
    plugins: [
      {
        id: "duplicate",
        setup(tessar) {
          tessar.agent.register(agent);
        },
      },
    ],
  });
  await expect(controller.initialize()).rejects.toMatchObject({
    code: "RegistrationConflict",
  });
  await controller.dispose();
});
