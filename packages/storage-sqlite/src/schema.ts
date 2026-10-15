import type { DatabaseSync } from "node:sqlite";
export const recordTables=["streams","turns","model_attempts","tool_executions","interrupts","plugin_states"] as const;
export function initializeSchema(db:DatabaseSync):void {
  const version=(db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
  if(version!==0&&version!==1)throw Error("Unsupported SQLite schema version");
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(thread_id,revision));
    CREATE TABLE IF NOT EXISTS staging(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commits(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases(thread_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owned_states(owner_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,checkpoint_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(checkpoint_id,id));
  `);
  for(const table of recordTables)db.exec("CREATE TABLE IF NOT EXISTS "+table+"(thread_id TEXT NOT NULL,checkpoint_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(checkpoint_id,id));CREATE INDEX IF NOT EXISTS "+table+"_thread ON "+table+"(thread_id);");
  db.exec("PRAGMA user_version=1");
}
