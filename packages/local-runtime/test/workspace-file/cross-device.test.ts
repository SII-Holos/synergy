import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { FileEntry } from "../../src/file/entry"
import { testRuntime } from "../support/runtime"

const darwin = process.platform === "darwin" ? test : test.skip
darwin(
  "workspace directory moves across a mounted filesystem preserve files and remove the source",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      const image = path.join(tmp.path, "fixture.dmg"),
        mount = path.join(tmp.path, "mounted")
      const command = async (args: string[]) => {
        const child = Bun.spawn(["/usr/bin/hdiutil", ...args], { stdout: "pipe", stderr: "pipe" })
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(`Isolated disk fixture failed: ${out} ${err}`)
      }
      await command(["create", "-quiet", "-size", "32m", "-fs", "HFS+", "-volname", "SynergyFileFixture", image])
      await fs.mkdir(mount)
      let attached = false
      try {
        await command(["attach", "-quiet", "-nobrowse", "-mountpoint", mount, image])
        attached = true
        expect((await fs.stat(mount)).dev).not.toBe((await fs.stat(tmp.path)).dev)
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            await fs.mkdir(path.join(tmp.path, "source"))
            const content = Buffer.alloc(256 * 1024, 197)
            await Bun.write(path.join(tmp.path, "source", "data.bin"), content)
            const source = await WorkspaceFileService.node("source")
            const result = await WorkspaceFileService.move({
              from: "source",
              to: "mounted/moved",
              expectedVersion: source.entryVersion!,
            })
            expect(result.path).toBe("mounted/moved")
            expect(Buffer.from(await Bun.file(path.join(mount, "moved", "data.bin")).bytes()).equals(content)).toBe(
              true,
            )
            expect((await fs.readdir(tmp.path)).includes("source")).toBe(false)
            const retained = path.join(tmp.path, "retained.txt"),
              copied = path.join(mount, "copied.txt")
            await Bun.write(retained, "before")
            let validations = 0
            const failure = await FileEntry.move({
              from: retained,
              to: copied,
              expectedVersion: (await FileEntry.inspect(retained))!.version,
              async validate(target, operation) {
                if (target === copied && operation === "write" && ++validations === 3)
                  await Bun.write(retained, "after")
              },
            }).then(
              () => undefined,
              (error) => error,
            )
            expect(failure).toBeInstanceOf(FileEntry.PartialError)
            expect(failure.completed).toEqual([copied])
            expect(await Bun.file(retained).text()).toBe("after")
            expect(await Bun.file(copied).text()).toBe("before")
          },
        })
      } finally {
        if (attached) await command(["detach", "-quiet", mount])
      }
    })
  },
  60_000,
)
