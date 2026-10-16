export * from "./backend.js";
import type { Plugin,PluginContext } from "@tessar/core";
import { createSqliteBackend } from "./backend.js";
export class SqliteStoragePlugin implements Plugin {
 readonly id="storage.sqlite";
 constructor(private readonly options:{filename:string}){}
 async setup(tessar:PluginContext):Promise<void>{tessar.storage.registerBackend(await createSqliteBackend(this.options));}
}
