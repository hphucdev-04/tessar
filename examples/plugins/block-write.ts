import { tool as toolHooks } from "@tessar/core";
import { type Plugin } from "@tessar/core";
const blockWrite: Plugin = {
  id: "block-write",
  setup(tessar) {
    tessar.hook(toolHooks.before, (event) => {
      if (event.payload.tool.name === "write")
        return { decision: "deny", reason: "Write tool disabled" };
    });
  },
};
export default blockWrite;
