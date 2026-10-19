import { model, models, type Model, type Schema } from "mongoose";

/**
 * Reuse a compiled model where one already exists. Bun's `--hot` reloads
 * modules without clearing Mongoose's model registry, so calling `model()`
 * twice for the same name throws unless we guard here.
 */
export function getModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (models[name] as Model<T> | undefined) ?? model<T>(name, schema);
}
