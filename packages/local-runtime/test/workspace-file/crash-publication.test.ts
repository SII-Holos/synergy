import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileEntry } from "../../src/file/entry"

test.each(["copy", "restore"] as const)(
  "abrupt %s termination preserves the destination and permits a verified retry",
  async (kind) => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "source")
    const target = path.join(tmp.path, "target")
    const foreign = path.join(tmp.path, ".synergy-copy-user-owned")
    await fs.writeFile(source, "complete new bytes")
    await fs.writeFile(foreign, "unrelated data")
    if (kind === "restore") await fs.writeFile(target, "original bytes")
    const module = path.resolve(import.meta.dir, "../../src/file/entry.ts")
    const command =
      kind === "copy"
        ? `let validations = 0; await FileEntry.copy({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source)).version, validate: async (file, operation) => { if (file === target && operation === "write" && ++validations === 2) await barrier() } })`
        : `let validations = 0; await FileEntry.replace({ path: target, expectedVersion: (await FileEntry.inspect(target)).version, content: new TextEncoder().encode("complete new bytes"), mode: "100644", validate: async () => { if (++validations === 2) await barrier() } })`
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import { FileEntry } from ${JSON.stringify(module)};
    const source = ${JSON.stringify(source)}, target = ${JSON.stringify(target)};
    const barrier = async () => { console.log("staged"); await Bun.sleep(60_000) };
    ${command};
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = child.stdout.getReader()
    try {
      const ready = await reader.read()
      if (ready.done) throw new Error(await new Response(child.stderr).text())
      expect(new TextDecoder().decode(ready.value).trim()).toBe("staged")
      child.kill("SIGKILL")
      await child.exited
      expect(await FileEntry.inspect(target)).toEqual(
        kind === "copy" ? null : expect.objectContaining({ type: "file" }),
      )
      if (kind === "restore") expect(await fs.readFile(target, "utf8")).toBe("original bytes")
      const interrupted = (await fs.readdir(tmp.path)).filter(
        (name) => name !== path.basename(foreign) && name.startsWith(".synergy-"),
      )
      expect(interrupted).toHaveLength(1)
      if (kind === "copy")
        await FileEntry.copy({ from: source, to: target, expectedVersion: (await FileEntry.inspect(source))!.version })
      else
        await FileEntry.replace({
          path: target,
          expectedVersion: (await FileEntry.inspect(target))!.version,
          content: new TextEncoder().encode("complete new bytes"),
          mode: "100644",
        })
      expect(await fs.readFile(target, "utf8")).toBe("complete new bytes")
      expect(await fs.readFile(foreign, "utf8")).toBe("unrelated data")
      expect((await fs.readdir(tmp.path)).filter((name) => interrupted.includes(name))).toEqual(interrupted)
    } finally {
      reader.releaseLock()
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  },
  15_000,
)
