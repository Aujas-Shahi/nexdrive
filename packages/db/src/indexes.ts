import { Asset } from "./models/asset";
import { File } from "./models/file";
import { Folder } from "./models/folder";
import { RateLimitWindow } from "./models/rate-limit-window";
import { User } from "./models/user";

/**
 * Build every index declared on the domain schemas.
 *
 * Mongoose builds indexes automatically when `autoIndex` is on, but the seed
 * script and tests call this explicitly so the demo can prove the index set
 * exists (compound, partial-unique, and TTL) without relying on timing.
 */
export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    User.createIndexes(),
    File.createIndexes(),
    Folder.createIndexes(),
    Asset.createIndexes(),
    RateLimitWindow.createIndexes(),
  ]);
}
