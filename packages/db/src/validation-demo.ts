/**
 * Demonstrate the `$jsonSchema` validators.
 *
 * Writes straight through the MongoDB driver, bypassing Mongoose, so every
 * rejection below comes from the database server itself. Run after the seed
 * (which attaches the validators): `bun run db:validation-demo`
 */
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoServerError, ObjectId, type Document } from "mongodb";
import { connectDB, getDb } from "./connection";
import { VALIDATORS } from "./validators";

dotenv.config({ path: fileURLToPath(new URL("../../../apps/server/.env", import.meta.url)) });

const DOCUMENT_VALIDATION_FAILURE = 121;
const HASH = "0".repeat(64);

const validFolder = () => ({
  name: "Demo",
  userId: new ObjectId(),
  parentId: null,
  deletedAt: null,
});

const validAsset = () => ({
  name: "demo.txt",
  contentType: "text/plain",
  userId: new ObjectId(),
  folderId: null,
  fileHash: HASH,
  isPublic: false,
  publicShareId: null,
  downloadCount: 0,
  deletedAt: null,
});

const CASES: { collection: string; label: string; doc: Document }[] = [
  {
    collection: "files",
    label: "blob with a negative size",
    doc: { _id: HASH, size: -5, path: HASH, refCount: 1 },
  },
  {
    collection: "files",
    label: "blob keyed by something that is not a SHA-256",
    doc: { _id: "not-a-hash", size: 10, path: "x", refCount: 1 },
  },
  {
    collection: "files",
    label: "blob with no refCount",
    doc: { _id: HASH, size: 10, path: HASH },
  },
  {
    collection: "folders",
    label: "folder with an empty name",
    doc: { ...validFolder(), name: "" },
  },
  {
    collection: "folders",
    label: "folder whose owner is a string, not an ObjectId",
    doc: { ...validFolder(), userId: "alice" },
  },
  {
    collection: "assets",
    label: "asset with no name",
    doc: (({ name: _, ...rest }) => rest)(validAsset()),
  },
  {
    collection: "assets",
    label: 'asset with isPublic: "yes" instead of a boolean',
    doc: { ...validAsset(), isPublic: "yes" },
  },
  {
    collection: "assets",
    label: "asset with a negative download count",
    doc: { ...validAsset(), downloadCount: -1 },
  },
];

async function main(): Promise<void> {
  await connectDB(process.env.MONGODB_URI);
  const db = getDb();

  console.log("\n=== NexDrive $jsonSchema validation demo ===\n");

  const collections = await db
    .listCollections({ name: { $in: Object.keys(VALIDATORS) } })
    .toArray();
  for (const name of Object.keys(VALIDATORS)) {
    const info = collections.find((c) => c.name === name);
    const options = info && "options" in info ? info.options : undefined;
    if (!options?.validator) {
      throw new Error(`${name} has no validator — run \`bun run db:seed\` first`);
    }
    const required = options.validator.$jsonSchema.required as string[];
    console.log(`  ${name.padEnd(8)} validator on (required: ${required.join(", ")})`);
  }

  console.log("\n  malformed inserts:");
  let rejected = 0;
  for (const { collection, label, doc } of CASES) {
    try {
      const { insertedId } = await db.collection(collection).insertOne(doc);
      await db.collection(collection).deleteOne({ _id: insertedId });
      console.log(`  ✗ ACCEPTED  ${collection}: ${label}`);
    } catch (error) {
      if (
        error instanceof MongoServerError &&
        error.code === DOCUMENT_VALIDATION_FAILURE
      ) {
        rejected++;
        console.log(`  ✓ rejected  ${collection}: ${label}`);
      } else {
        throw error;
      }
    }
  }

  // A well-formed document still goes through.
  const { insertedId } = await db.collection("folders").insertOne(validFolder());
  await db.collection("folders").deleteOne({ _id: insertedId });
  console.log("\n  ✓ accepted  folders: a well-formed folder (then removed)");

  if (rejected !== CASES.length) {
    throw new Error(`${CASES.length - rejected} malformed document(s) were accepted`);
  }
  console.log(`\n=== ${rejected}/${CASES.length} malformed documents rejected by MongoDB ===\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error("validation demo failed:", error.message ?? error);
  process.exit(1);
});
