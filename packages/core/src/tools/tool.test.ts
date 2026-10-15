import { expect, it } from "vitest";
import { Tool, createTool, toolResult } from "./tool.js";
import type { InputDefinition } from "./input-definition.js";
const input: InputDefinition<{count:number}> = {jsonSchema:{type:"object",properties:{count:{type:"number"}}},parse(value){
  if (!value || typeof value !== "object" || typeof (value as {count?:unknown}).count !== "number") throw Error("count required");
  return value as {count:number};
}};
it("uses the same Tool instance contract and inferred validated inputs", async () => {
  const tool = createTool({name:"count",description:"Count",input,execute:async value=>toolResult(String(value.count+1))});
  expect(tool).toBeInstanceOf(Tool);
  expect(await tool.execute(tool.input.parse({count:2}), {} as never)).toEqual({content:[{type:"text",text:"3"}]});
  expect(() => tool.input.parse({count:"bad"})).toThrow();
});
