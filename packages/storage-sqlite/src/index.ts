export * from "./backend.js";
import type { Plugin,PluginContext } from "@tesseract/core";
import { createSqliteBackend } from "./backend.js";
export class SqliteStoragePlugin implements Plugin {
 readonly id="storage.sqlite";readonly apiVersion=1;
 constructor(private readonly options:{filename:string}){}
 async setup(api:PluginContext):Promise<void>{api.storage.registerBackend(await createSqliteBackend(this.options));}
}
