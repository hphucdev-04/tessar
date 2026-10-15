import { fail,requireId } from "../errors.js";
import { immutable,type JsonValue } from "../json.js";
import type { PluginStateSnapshot } from "./schema.js";
export interface PluginStateDefinition<T extends JsonValue=JsonValue> {pluginId:string;namespace:string;schemaVersion:number;initial:T;migrate?:(value:JsonValue,fromVersion:number)=>T;fork?:"copy"|"reset"|((value:T,context:{sourceThreadId:string;targetThreadId:string})=>T)}
export function definePluginState<T extends JsonValue>(definition:PluginStateDefinition<T>):PluginStateDefinition<T> {
  requireId(definition.pluginId);requireId(definition.namespace);if(!Number.isInteger(definition.schemaVersion)||definition.schemaVersion<1)fail("InvalidConfiguration","Invalid state version");
  return Object.freeze({...definition,initial:immutable(definition.initial) as T});
}
export class PluginStateAccess {
  private entries:PluginStateSnapshot[];
  constructor(private readonly definitions:readonly PluginStateDefinition<any>[],private readonly owner:{type:PluginStateSnapshot["ownerType"];id:string},entries:readonly PluginStateSnapshot[]=[],private readonly publish?:()=>Promise<string>) {this.entries=entries.slice();}
  private resolve<T extends JsonValue>(definition:PluginStateDefinition<T>):PluginStateSnapshot {
    if(!this.definitions.some(d=>d.pluginId===definition.pluginId&&d.namespace===definition.namespace&&d.schemaVersion===definition.schemaVersion))fail("RegistrationConflict","Plugin state not registered");
    let entry=this.entries.find(s=>s.pluginId===definition.pluginId&&s.namespace===definition.namespace&&s.ownerType===this.owner.type&&s.ownerId===this.owner.id);
    if(!entry){entry={pluginId:definition.pluginId,namespace:definition.namespace,ownerType:this.owner.type,ownerId:this.owner.id,schemaVersion:definition.schemaVersion,revision:0,data:definition.initial};this.entries.push(entry);}
    if(entry.schemaVersion!==definition.schemaVersion){
      if(entry.schemaVersion>definition.schemaVersion||!definition.migrate)fail("PluginStateIncompatible","Missing state migration");
      const migrated=immutable({...entry,schemaVersion:definition.schemaVersion,revision:entry.revision+1,data:definition.migrate(entry.data,entry.schemaVersion)});
      this.entries[this.entries.indexOf(entry)]=migrated;entry=migrated;
    }
    return entry;
  }
  get<T extends JsonValue>(definition:PluginStateDefinition<T>):T {return immutable(this.resolve(definition).data) as T;}
  update<T extends JsonValue>(definition:PluginStateDefinition<T>,value:T|((previous:T)=>T)):void {
    const entry=this.resolve(definition),data=typeof value==="function"?value(this.get(definition)):value;
    this.entries[this.entries.indexOf(entry)]=immutable({...entry,revision:entry.revision+1,data});
  }
  snapshots():readonly PluginStateSnapshot[]{return immutable(this.entries);}
  async commit():Promise<string>{if(!this.publish)fail("UnsupportedBoundary","State commits require an execution boundary");return this.publish();}
}
