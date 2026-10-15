import { expect, it } from "vitest";
import { defineEvent, EventEnvelope } from "./definition.js";
import { PluginHost } from "../plugins/host.js";
const Transform = defineEvent<string, string, "transformation">({ id: "test.transform", owner: "test", version: 1, kind: "transformation" });
const Decide = defineEvent<{}, {decision: "allow" | "deny"}, "decision">({ id: "test.decide", owner: "test", version: 1, kind: "decision" });
const Notice = defineEvent<string, void, "notification">({ id: "test.notice", owner: "test", version: 1, kind: "notification" });
it("chains transformations and never overturns a denial", async () => {
  const host = new PluginHost();
  await host.initialize([{ id: "test", apiVersion: 1, setup(api) {
    api.on(Transform, e => e.payload + "A");
    api.on(Transform, e => e.payload + "B");
    api.on(Decide, () => ({ decision: "deny" as const }));
    api.on(Decide, () => ({ decision: "allow" as const }));
  } }]);
  expect(await host.dispatch(Transform, "x")).toBe("xAB");
  expect(await host.dispatch(Decide, {})).toEqual({ decision: "deny" });
  await host.dispose();
});
it("looks definitions up by stable ID and reports observer failures without changing outcome", async () => {
  const diagnostics: string[] = [];
  const host = new PluginHost({ diagnostics: e => diagnostics.push(e.code) });
  await host.initialize([{ id: "test", apiVersion: 1, setup(api) { api.on(Notice, () => { throw Error("observer"); }); } }]);
  const equivalent = defineEvent<string, void, "notification">({ id: "test.notice", owner: "test", version: 1, kind: "notification" });
  await expect(host.dispatch(equivalent, "x")).resolves.toBeUndefined();
  expect(diagnostics).toEqual(["PluginError"]);
  const envelope = new EventEnvelope(Notice, "hello");
  expect(envelope.is(equivalent)).toBe(true);
  await host.dispose();
});
