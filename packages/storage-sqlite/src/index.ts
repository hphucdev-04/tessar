export * from "./backend.js";
import type { Plugin,PluginContext } from "@tesseract/core";
import { createSqliteBackend } from "./backend.js";
export class SqliteStoragePlugin implements Plugin {
 readonly id="storage.sqlite";
 constructor(private readonly options:{filename:string}){}
 async setup(tesseract:PluginContext):Promise<void>{tesseract.storage.registerBackend(await createSqliteBackend(this.options));}
}
