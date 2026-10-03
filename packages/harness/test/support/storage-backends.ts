import type { StoreOptions } from "../../src/storage/sql-contract"

export const POSTGRES_TEST_FILES = [
  "test/storage/artifact-pack.test.ts",
  "test/storage/backend-selection.test.ts",
  "test/storage/compat-defer.test.ts",
  "test/storage/large-artifacts.test.ts",
  "test/storage/packed-import.test.ts",
  "test/session/message-read-errors.test.ts",
  "test/storage/postgres-contract.test.ts",
  "test/storage/postgres-ownership.test.ts",
  "test/storage/prune-contract.test.ts",
  "test/storage/transactional-store.test.ts",
  "test/storage/text-projection.test.ts",
  "test/storage/usage-ledger.test.ts",
] as const

type Backend = "sqlite" | "postgres"
type Environment = Readonly<Record<string, string | undefined>>

export function storageTestBackends(env: Environment = process.env): Backend[] {
  const selected = env.SYNERGY_TEST_STORAGE_BACKEND
  const required = env.SYNERGY_REQUIRE_POSTGRES_TESTS === "1"
  if (selected !== undefined && selected !== "sqlite" && selected !== "postgres")
    throw new Error(`Unknown storage test backend: ${selected}`)
  if (required && selected === "sqlite") throw new Error("This test invocation requires PostgreSQL")
  if ((required || selected === "postgres") && !env.SYNERGY_TEST_POSTGRES_URL)
    throw new Error("PostgreSQL contract tests require a real database")
  if (selected) return [selected]
  return env.SYNERGY_TEST_POSTGRES_URL ? ["sqlite", "postgres"] : ["sqlite"]
}

export function storageTestOptions(
  input: { namespace: string; filename: string },
  env: Environment = process.env,
): StoreOptions {
  const backend = storageTestBackends(env).at(-1)!
  return backend === "postgres"
    ? { backend, namespace: input.namespace, url: env.SYNERGY_TEST_POSTGRES_URL! }
    : { backend, ...input }
}
