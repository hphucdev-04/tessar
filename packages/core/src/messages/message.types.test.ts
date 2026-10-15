import { it, expect } from "vitest";
import { HumanMessage } from "./message.js";
it("exposes readonly message contracts", () => {
  const message = new HumanMessage("x");
  if (false) {
    // @ts-expect-error message IDs are immutable
    message.id = "other";
    // @ts-expect-error content is readonly
    message.content.push({ type: "text", text: "mutate" });
  }
  expect(message.content).toHaveLength(1);
});
