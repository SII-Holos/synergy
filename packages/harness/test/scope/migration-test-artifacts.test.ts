import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Scope } from "../../src/scope"
import { migrations } from "../../src/scope/migration"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { StoragePath } from "../../src/storage/path"

describe("20260827-scope-archive-ephemeral-test-artifacts", () => {
  test("archives ephemeral test-artifact scopes and keeps their data", async () => {
    // Create a real temp directory that mimics a leaked test fixture worktree.
    const dir = path.join(os.tmpdir(), `synergy-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const { scope } = await Scope.fromDirectory(dir)
      expect(scope.type).toBe("project")
      expect((await Scope.list()).some((item) => item.id === scope.id)).toBe(false) // filtered before migration

      const migration = migrations.find((entry) => entry.id === "20260827-scope-archive-ephemeral-test-artifacts")
      expect(migration).toBeDefined()
      await migration!.up(() => {})

      // The record is archived (time.archived set) and remains on disk.
      const persisted = await Storage.read<{
        id: string
        worktree?: string
        time?: { archived?: number }
      }>(StoragePath.scope(Identifier.asScopeID(scope.id)))
      expect(persisted.time?.archived).toBeGreaterThan(0)
      expect(persisted.worktree).toBe(scope.worktree)

      // The worktree directory itself is untouched (data preserved).
      expect(await fs.stat(dir)).toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("is idempotent and skips already-archived records", async () => {
    const dir = path.join(os.tmpdir(), `synergy-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const { scope } = await Scope.fromDirectory(dir)
      const migration = migrations.find((entry) => entry.id === "20260827-scope-archive-ephemeral-test-artifacts")!
      await migration.up(() => {})
      const archivedAt = (
        await Storage.read<{ time?: { archived?: number } }>(StoragePath.scope(Identifier.asScopeID(scope.id)))
      ).time?.archived
      expect(archivedAt).toBeGreaterThan(0)

      await migration.up(() => {})
      const afterSecondRun = await Storage.read<{ time?: { archived?: number } }>(
        StoragePath.scope(Identifier.asScopeID(scope.id)),
      )
      expect(afterSecondRun.time?.archived).toBe(archivedAt)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("does not archive a real project scope", async () => {
    const dir = path.join(os.tmpdir(), `real-project-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const { scope } = await Scope.fromDirectory(dir)
      const migration = migrations.find((entry) => entry.id === "20260827-scope-archive-ephemeral-test-artifacts")!
      await migration.up(() => {})
      const persisted = await Storage.read<{ time?: { archived?: number } }>(
        StoragePath.scope(Identifier.asScopeID(scope.id)),
      )
      expect(persisted.time?.archived).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
