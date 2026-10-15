import {expect,it} from "vitest";
import * as core from "../src/index.js";
it("provides Agent Controller and Session directly from the core package",()=>{
 expect(typeof (core as any).Agent).toBe("function");
 expect(typeof (core as any).Controller).toBe("function");
 expect(typeof (core as any).Session).toBe("function");
 expect("AgentEngine" in core).toBe(false);
});
