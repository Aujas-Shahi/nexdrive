import { Types } from "mongoose";

/**
 * NexDrive uses MongoDB ObjectIds for user-generated identity (users, folders,
 * assets, and their references), and a SHA-256 hex string for `files._id`
 * because that collection is content-addressed.
 *
 * MongoDB never coerces types in queries: a string and an ObjectId with the same
 * text do not match. Every boundary that receives an id from outside the
 * database (an HTTP input, a session) must convert it with `toObjectId`.
 */
export const ObjectId = Types.ObjectId;
export type ObjectId = Types.ObjectId;

export function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

/** Serialize an ObjectId-ish value to its hex string form (or null). */
export function idString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
