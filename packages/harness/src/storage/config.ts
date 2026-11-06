import fs from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { StorageIntegrityError } from "./errors"
import type { StoreOptions } from "./sql-contract"

const Namespace = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const StorageConfiguration = z.discriminatedUnion("backend", [
  z
    .object({ backend: z.literal("sqlite"), namespace: Namespace.optional(), filename: z.string().min(1).optional() })
    .strict(),
  z
    .object({
      backend: z.literal("postgres"),
      namespace: Namespace,
      connectionEnv: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
      maxConnections: z.number().int().min(2).max(64).optional(),
    })
    .strict(),
])
export type StorageConfiguration = z.infer<typeof StorageConfiguration>

export async function readStorageConfiguration(root: string): Promise<StorageConfiguration> {
  let source: string
  try {
    source = await fs.readFile(path.join(root, "config", "synergy.d", "130-storage.jsonc"), "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { backend: "sqlite" }
    throw error
  }
  return parseStorageConfiguration(source)
}

export function parseStorageConfiguration(source: string): StorageConfiguration {
  const errors: ParseError[] = []
  const value: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length) throw new StorageIntegrityError("Storage bootstrap configuration is not valid JSONC")
  return z.object({ storage: StorageConfiguration, $schema: z.string().optional() }).strict().parse(value).storage
}

export function resolveStoreOptions(
  root: string,
  configuration: StorageConfiguration,
  namespace: string,
): StoreOptions {
  if (configuration.namespace && configuration.namespace !== namespace)
    throw new StorageIntegrityError("Configured namespace differs from the active data namespace")
  if (configuration.backend === "sqlite")
    return {
      backend: "sqlite",
      namespace,
      filename: configuration.filename
        ? path.resolve(root, configuration.filename)
        : path.join(root, "data", "storage", "agent.sqlite"),
    }
  const url = process.env[configuration.connectionEnv]
  if (!url)
    throw new StorageIntegrityError(
      `Storage connection environment variable ${configuration.connectionEnv} is unavailable`,
    )
  const parsed = new URL(url)
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    throw new StorageIntegrityError("PostgreSQL storage requires a PostgreSQL connection URL")
  return { backend: "postgres", namespace, url, maxConnections: configuration.maxConnections }
}
