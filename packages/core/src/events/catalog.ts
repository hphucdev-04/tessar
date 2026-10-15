import { defineEvent } from "./definition.js";
export const AgentEvents = {
  Ready: defineEvent<{ agentId: string }, void, "notification">({ id: "core.ready", owner: "core", version: 1, kind: "notification" }),
  Shutdown: defineEvent<{}, void, "barrier">({ id: "core.shutdown", owner: "core", version: 1, kind: "barrier" }),
} as const;
