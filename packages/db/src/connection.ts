import mongoose from "mongoose";
import type { ClientSession } from "mongoose";
import type { Db, MongoClient } from "mongodb";

/**
 * A single shared Mongoose connection for the whole server process.
 *
 * Mongoose is used for the domain collections (files, folders, assets, …) and
 * the same underlying MongoClient is handed to Better Auth's MongoDB adapter,
 * so both layers share one connection pool and one transaction-capable session
 * factory.
 */
let connectionPromise: Promise<typeof mongoose> | null = null;

export async function connectDB(uri?: string): Promise<typeof mongoose> {
  const connectionString = uri ?? process.env.MONGODB_URI;

  if (!connectionString) {
    throw new Error("MONGODB_URI environment variable is required");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(connectionString, {
        // Indexes are created from the schema definitions. This is what the
        // demo and the seed script rely on; production would build them once
        // out of band.
        autoIndex: true,
        serverSelectionTimeoutMS: 10_000,
      })
      .catch((error) => {
        // Allow a later call to retry instead of caching a rejected promise.
        connectionPromise = null;
        throw error;
      });
  }

  return connectionPromise;
}

/** The raw driver `Db`, used by Better Auth's MongoDB adapter. */
export function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB is not connected. Call connectDB() before use.");
  }
  return db;
}

/** The raw driver `MongoClient`, required for multi-document transactions. */
export function getClient(): MongoClient {
  const client = mongoose.connection.getClient();
  if (!client) {
    throw new Error("MongoDB client is not available. Call connectDB() first.");
  }
  return client;
}

/**
 * Run `fn` inside a multi-document transaction.
 *
 * Every NexDrive operation that touches more than one collection — upload, dedup
 * hit, delete, trash/restore, empty-trash — goes through here so ref-counts and
 * quota deltas can never tear. `withTransaction` retries on transient errors and
 * aborts on anything thrown. Requires a replica set.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export { mongoose };
