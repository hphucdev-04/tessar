import {
  MongoClient,
  MongoServerError,
  type MongoClientOptions,
  type ClientSession,
} from "mongodb";
import { fail } from "@tessar/core";
import { initializeSchema } from "./schema.js";

export interface MongoDBStorageOptions {
  uri: string;
  databaseName: string;
  clientOptions?: MongoClientOptions;
}

export async function openDatabase(options: MongoDBStorageOptions) {
  if (!options.databaseName)
    fail("InvalidConfiguration", "MongoDB databaseName is required");
  const client = new MongoClient(options.uri, options.clientOptions);
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= client.close());
  try {
    await client.connect();
    const collections = await initializeSchema(client.db(options.databaseName));
    async function transaction<T>(
      action: (session: ClientSession) => Promise<T>,
    ): Promise<T> {
      const session = client.startSession();
      try {
        return (await session.withTransaction(() => action(session), {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        }))!;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000)
          fail("CommitConflict", "Storage identity or revision already exists");
        throw error;
      } finally {
        await session.endSession();
      }
    }

    return { ...collections, transaction, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
