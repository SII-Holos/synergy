import { afterAll, expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { FileEntry } from "../../src/file/entry"
import { FileLink } from "../../src/file/link"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function exportSnapshots(
  sessionID: string,
  roots: string[],
  consume: (packs: string[], roots: string[]) => Promise<void>,
) {
  try {
    return await SnapshotArchive.exportSession(sessionID, roots, consume)
  } catch (error) {
    const details = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== "object" || depth > 5) return
      if (value instanceof Error) console.error(`Snapshot transfer: ${value.name}: ${value.message}`)
      for (const key of ["error", "suppressed", "cause"])
        if (key in value) details((value as Record<string, unknown>)[key], depth + 1)
    }
    details(error)
    throw error
  }
}

async function* readPack(file: string) {
  yield await fs.readFile(file)
}

const envelope = (kind: string, target: string) =>
  Buffer.from("\0SynergySnapshotLink\0" + JSON.stringify({ version: 1, kind, target }))

test("versioned link snapshots preserve literal targets while regular files keep the same bytes", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const link = path.join(directory.path, "link")
        const bytes = envelope("dir", "missing target")
        await FileEntry.replace({ path: link, expectedVersion: null, content: bytes, mode: "120000" })
        expect(await fs.readlink(link)).toBe("missing target")
        if (process.platform === "win32") expect(FileLink.type(link)).toBe("dir")
        const file = path.join(directory.path, "ordinary.txt")
        await FileEntry.replace({ path: file, expectedVersion: null, content: bytes, mode: "100644" })
        expect(await fs.readFile(file)).toEqual(bytes)
        await expect(
          FileEntry.replace({
            path: link,
            expectedVersion: (await FileEntry.inspect(link))!.version,
            content: envelope("future-kind", "different"),
            mode: "120000",
          }),
        ).rejects.toThrow()
        expect(await fs.readlink(link)).toBe("missing target")
      },
    })
  }))

test.skipIf(process.platform !== "win32")(
  "Windows snapshots retain dangling link kinds through archive import and detect a kind-only change",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const files = ["file", "dir", "junction"].map((kind) => path.join(directory.path, kind))
          const target = path.join(directory.path, "missing target")
          for (const [index, kind] of (["file", "dir", "junction"] as const).entries())
            await fs.symlink(target, files[index]!, kind)
          const links = await Promise.all(files.map((file) => fs.readlink(file)))
          const before = (await Snapshot.track("link-kinds"))!
          expect(before).toBeString()
          const workspace = Snapshot.workspace()!
          await fs.unlink(files[0]!)
          await fs.symlink(target, files[0]!, "dir")
          const after = (await Snapshot.track("link-kinds"))!
          expect(after).not.toBe(before)
          const diff = await Snapshot.diffSummary(before, after, "link-kinds")
          expect(diff).toHaveLength(1)
          expect(diff[0]!.binary).not.toBe(true)
          expect(diff[0]!.preview).toContain("Directory symbolic link")
          expect(diff[0]!.preview).not.toContain("\0")
          const exported = await exportSnapshots("link-kinds", [before], async (packs, roots) => {
            await SnapshotArchive.importSession("link-kinds-copy", roots, packs.map(readPack))
          })
          expect(exported.missing).toEqual([])
          for (const file of files) await fs.unlink(file)
          const result = await Snapshot.revert([{ hash: before, workspace, files }], "link-kinds-copy")
          expect(result.failedFiles).toEqual([])
          expect(result.restoredFiles).toEqual(files)
          expect(files.map((file) => FileLink.type(file))).toEqual(["file", "dir", "junction"])
          expect(await Promise.all(files.map((file) => fs.readlink(file)))).toEqual(links)
          expect(await fs.lstat(target).catch(() => null)).toBeNull()
          const legacy = path.join(directory.path, "legacy")
          await expect(
            FileEntry.replace({
              path: legacy,
              expectedVersion: null,
              content: Buffer.from("unknown target"),
              mode: "120000",
            }),
          ).rejects.toThrow("native kind")
          expect(await fs.lstat(legacy).catch(() => null)).toBeNull()
        },
      })
    }),
)

test("native link metadata survives snapshot diff and object transfer", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        let kind: "file" | "dir" = "file"
        using native = spyOn(FileLink, "type").mockImplementation(() => kind)
        const file = path.join(directory.path, "link")
        await fs.symlink("missing target", file, "file")
        const before = (await Snapshot.track("encoded-link"))!
        expect(before).toBeString()
        kind = "dir"
        const after = (await Snapshot.track("encoded-link"))!
        expect(after).not.toBe(before)
        const diffs = await Snapshot.diffSummary(before, after, "encoded-link")
        expect(diffs).toHaveLength(1)
        expect(diffs[0]!.binary).not.toBe(true)
        expect(diffs[0]!.preview).toContain("File symbolic link")
        expect(diffs[0]!.preview).toContain("Directory symbolic link")
        expect(diffs[0]!.preview).not.toContain("\0")
        const exported = await exportSnapshots("encoded-link", [before], async (packs, roots) => {
          await SnapshotArchive.importSession("encoded-link-copy", roots, packs.map(readPack))
        })
        expect(exported.missing).toEqual([])
        await fs.unlink(file)
        const result = await Snapshot.revert(
          [{ hash: before, workspace: Snapshot.workspace()!, files: [file] }],
          "encoded-link-copy",
        )
        expect(result.failedFiles).toEqual([])
        expect(await fs.readlink(file)).toBe("missing target")
      },
    })
  }))
