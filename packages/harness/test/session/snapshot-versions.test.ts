import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { registerSnapshotTestHost } from "../support/snapshot-host"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { Identifier } from "../../src/id/id"
import { mkdir } from "node:fs/promises"

test("historical versions retain captured text and never substitute the current file", async () => {
  await using runtime = await testRuntime({ register: registerSnapshotTestHost })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const sessionID = Identifier.descending("session")
        await Bun.write(path.join(directory.path, "unrelated.txt"), "unrelated\n")
        await Bun.write(path.join(directory.path, "version.txt"), "before\n")
        const longBefore = Array.from({ length: 20000 }, (_, index) => `export const row${index} = ${index}\n`).join("")
        await Bun.write(path.join(directory.path, "long.ts"), longBefore)
        const before = (await Snapshot.track(sessionID))!
        await Bun.write(path.join(directory.path, "version.txt"), "after\n")
        await Bun.write(path.join(directory.path, "long.ts"), longBefore.replace("row5 = 5", "row5 = 500"))
        const after = (await Snapshot.track(sessionID))!
        await Bun.write(path.join(directory.path, "version.txt"), "current\n")
        const run = SnapshotGit.run
        const metadata: string[] = []
        using git = spyOn(SnapshotGit, "run").mockImplementation(async (...args) => {
          const result = await run(...args)
          if (args[0].includes("ls-tree")) metadata.push(result.text)
          return result
        })
        const versions = await Snapshot.fileVersions(before, after, "version.txt", sessionID)
        const long = await Snapshot.fileVersions(before, after, "long.ts", sessionID)
        expect(metadata).not.toHaveLength(0)
        expect(metadata.every((text) => !text.includes("unrelated.txt"))).toBe(true)
        expect(long.before.content?.length).toBe(longBefore.length)
        expect(long.after.content).toContain("row5 = 500")
        expect(versions.before.content).toBe("before\n")
        expect(versions.after.content).toBe("after\n")
        expect(versions.before.version).not.toBe(versions.after.version)
        await expect(Snapshot.fileVersions(before, after, "../outside", sessionID)).rejects.toThrow()
        await expect(
          Snapshot.fileVersions(before, after, "version.txt", Identifier.descending("session")),
        ).rejects.toThrow()
      },
    })
  })
})

test("historical binary patches apply exactly and oversized versions stay bounded", async () => {
  await using runtime = await testRuntime({ register: registerSnapshotTestHost })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await using target = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const sessionID = Identifier.descending("session")
        const filename = "images/space and\nnewline.dat"
        const beforeBytes = new Uint8Array([0, 1, 2, 3]),
          afterBytes = new Uint8Array([0, 4, 5, 6])
        await mkdir(path.join(directory.path, "images"))
        await Bun.write(path.join(directory.path, filename), beforeBytes)
        const before = (await Snapshot.track(sessionID))!
        await Bun.write(path.join(directory.path, filename), afterBytes)
        await Bun.write(path.join(directory.path, "large.txt"), "x".repeat(1024 * 1024 + 1))
        const after = (await Snapshot.track(sessionID))!
        const versions = await Snapshot.fileVersions(before, after, filename, sessionID)
        expect(versions.before.kind).toBe("binary")
        expect(versions.after.base64).toBe(Buffer.from(afterBytes).toString("base64"))
        const large = await Snapshot.fileVersions(before, after, "large.txt", sessionID)
        expect(large.before.kind).toBe("missing")
        expect(large.after.kind).toBe("oversized")
        expect(large.after.content).toBeUndefined()
        const diff = await Snapshot.fileDiff(before, after, filename, sessionID)
        expect(diff!.patch).toContain("GIT binary patch")
        await mkdir(path.join(target.path, "images"))
        await Bun.write(path.join(target.path, filename), beforeBytes)
        const apply = Bun.spawn(["git", "apply", "--binary", "-"], {
          cwd: target.path,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
        apply.stdin.write(diff!.patch!)
        apply.stdin.end()
        const stderr = await new Response(apply.stderr).text()
        expect(await apply.exited, stderr).toBe(0)
        expect(new Uint8Array(await Bun.file(path.join(target.path, filename)).arrayBuffer())).toEqual(afterBytes)
      },
    })
  })
})
