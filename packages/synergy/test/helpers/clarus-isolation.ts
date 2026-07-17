/**
 * Per-file test isolation for Clarus test files.
 *
 * By default, all Bun test files in a single process share the preload's
 * SYNERGY_TEST_HOME under os.tmpdir()/synergy-test-data-${pid}. This means
 * Storage operations in different test files write to the same global
 * Clarus storage tree (clarus/bindings, clarus/outbox, etc.). Migration
 * runner tests that scan/remove/write bindings interfere with outbound-
 * runtime tests that seed/read bindings, causing nondeterministic failures
 * that pass in isolation but flake in `bun test test/clarus/`.
 *
 * This helper gives every Clarus test file a distinct SYNERGY_TEST_HOME
 * directory seeded with the required models cache. Storage operations
 * within the file resolve to that isolated directory because Global.Path.data
 * is a dynamic getter that re-reads process.env.SYNERGY_TEST_HOME on every
 * access (it is not cached at import time).
 *
 * Usage — at module scope, before any test registration:
 *
 *   import { isolateClarusHome } from "../helpers/clarus-isolation"
 *   isolateClarusHome(import.meta.url)
 */

import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

const baselineTestHome = process.env["SYNERGY_TEST_HOME"]
const baselineModelsCache = process.env["MODELS_DEV_API_JSON"]

export async function isolateClarusHome(fileUrl: string): Promise<void> {
  const fileKey = encodeURIComponent(fileUrl)
  const suffix = Math.random().toString(36).slice(2, 8)
  const dir = path.join(os.tmpdir(), `synergy-test-${fileKey}-${suffix}`)
  const testHome = path.join(dir, "home")
  const { closeDB } = await import("../../src/library/database")
  closeDB()

  await fs.mkdir(testHome, { recursive: true })

  // When a Clarus test file changes SYNERGY_TEST_HOME, the new home needs
  // the seeded models cache so that ModelsDev reads resolve correctly (the
  // preload writes the cache to its own test home and sets MODELS_DEV_API_JSON
  // to a path under it). We copy the original cache into the new home and
  // update MODELS_DEV_API_JSON so network-dependent code does not break.
  const cacheDir = path.join(testHome, ".synergy", "cache")
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(path.join(cacheDir, "version"), "15")

  if (baselineModelsCache) {
    try {
      const content = await fs.readFile(baselineModelsCache, "utf-8")
      const newCachePath = path.join(cacheDir, "models.json")
      await fs.writeFile(newCachePath, content)
      process.env["MODELS_DEV_API_JSON"] = newCachePath
    } catch {
      // original cache is missing or unreadable; leave MODELS_DEV_API_JSON
      // as-is (the old path is still valid for reads).
    }
  }

  // Also seed the data directory so that Storage.scan's readdir on a
  // non-existent directory returns [] instead of throwing (though Storage.scan
  // already catches and returns []; this avoids noise).
  await fs.mkdir(path.join(testHome, ".synergy", "data"), { recursive: true })

  process.env["SYNERGY_TEST_HOME"] = testHome

  // LibraryDB keeps a process-wide SQLite connection whose path is selected
  // from SYNERGY_TEST_HOME when first opened. Close it before restoring the
  // preload-owned paths, then remove this file's isolated home.
  afterAll(async () => {
    if (process.env["SYNERGY_TEST_HOME"] === testHome) {
      closeDB()
      if (baselineTestHome === undefined) delete process.env["SYNERGY_TEST_HOME"]
      else process.env["SYNERGY_TEST_HOME"] = baselineTestHome
    }
    if (process.env["MODELS_DEV_API_JSON"] === path.join(cacheDir, "models.json")) {
      if (baselineModelsCache === undefined) delete process.env["MODELS_DEV_API_JSON"]
      else process.env["MODELS_DEV_API_JSON"] = baselineModelsCache
    }
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Best-effort cleanup; /tmp is typically purged on reboot.
    }
  })
}
