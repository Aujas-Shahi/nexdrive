import type { Document } from "mongodb";
import { getDb } from "./connection";
import { COLLECTIONS } from "./constants";

/**
 * MongoDB `$jsonSchema` validators for the domain collections.
 *
 * Mongoose validates in the application, but anything that writes to the
 * database directly (the shell, a script, another service) bypasses it. These
 * validators make the server itself reject malformed documents, so the rules
 * hold no matter who writes. Extra fields are allowed (Mongoose adds `__v`);
 * the rules pin down the fields every query and transaction depends on.
 */

const objectId = { bsonType: "objectId" };
const objectIdOrNull = { bsonType: ["objectId", "null"] };
const dateOrNull = { bsonType: ["date", "null"] };
const sha256 = { bsonType: "string", pattern: "^[a-f0-9]{64}$" };
const name = { bsonType: "string", minLength: 1, maxLength: 255 };

/** FILE — the content-addressed blob registry, keyed by SHA-256. */
const filesSchema: Document = {
  bsonType: "object",
  required: ["_id", "size", "path", "refCount"],
  properties: {
    _id: { ...sha256, description: "SHA-256 of the content" },
    size: { bsonType: "number", minimum: 0, description: "bytes" },
    path: { bsonType: "string", minLength: 1, description: "object key in R2" },
    refCount: {
      bsonType: "number",
      minimum: 0,
      description: "number of assets claiming this blob",
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
};

/** FOLDER — the adjacency-list tree. */
const foldersSchema: Document = {
  bsonType: "object",
  required: ["name", "userId", "parentId", "deletedAt"],
  properties: {
    name,
    userId: objectId,
    parentId: { ...objectIdOrNull, description: "null at the root" },
    deletedAt: { ...dateOrNull, description: "set while in the trash" },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
};

/** ASSET — one user's claim on a blob. */
const assetsSchema: Document = {
  bsonType: "object",
  required: [
    "name",
    "userId",
    "folderId",
    "fileHash",
    "isPublic",
    "downloadCount",
    "deletedAt",
  ],
  properties: {
    name,
    contentType: { bsonType: ["string", "null"] },
    userId: objectId,
    folderId: { ...objectIdOrNull, description: "null at the root" },
    fileHash: { ...sha256, description: "-> files._id" },
    isPublic: { bsonType: "bool" },
    publicShareId: { bsonType: ["string", "null"] },
    downloadCount: { bsonType: "number", minimum: 0 },
    deletedAt: { ...dateOrNull, description: "set while in the trash" },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
};

export const VALIDATORS: Record<string, Document> = {
  [COLLECTIONS.files]: filesSchema,
  [COLLECTIONS.folders]: foldersSchema,
  [COLLECTIONS.assets]: assetsSchema,
};

/**
 * Attach the validators, creating each collection if it does not exist yet.
 *
 * `collMod` needs the dbAdmin role, so this runs from the seed script rather
 * than at server startup, where the app may hold a read-write-only user.
 */
export async function ensureValidators(): Promise<void> {
  const db = getDb();
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );

  for (const [collection, schema] of Object.entries(VALIDATORS)) {
    const options = {
      validator: { $jsonSchema: schema },
      validationLevel: "strict",
      validationAction: "error",
    } as const;

    if (existing.has(collection)) {
      await db.command({ collMod: collection, ...options });
    } else {
      await db.createCollection(collection, options);
    }
  }
}
