import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { OwnedProcess } from "../../src/process/owned-process"

const nativeTest = test.skipIf(process.platform !== "linux")

nativeTest(
  "a lost Linux supervisor preserves uncertainty after its escaped descendant exits",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "descendant")
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [directory.path],
    })
    const script = `await Bun.write(${JSON.stringify(marker)},String(process.pid)); setInterval(() => {},1000)`
    const root = `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e',${JSON.stringify(script)}],{env:{},stdio:'ignore',detached:true}); c.unref()`
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: ["-e", root],
      cwd: directory.path,
      env: {},
      lease,
    })
    owned.child.stdout.resume()
    owned.child.stderr.resume()
    let descendant: number | undefined
    const claim = (await coordinator.inspect())[0]!
    try {
      await owned.activate()
      const until = Date.now() + 5000
      while (!(await Bun.file(marker).exists())) {
        if (Date.now() >= until) throw new Error("Descendant did not start")
        await Bun.sleep(10)
      }
      descendant = Number(await Bun.file(marker).text())
      process.kill(claim.pid, "SIGKILL")
      await expect(owned.completion).rejects.toThrow("ownership remains uncertain")
      await lease.release()
      expect(await coordinator.inspect()).toHaveLength(1)
      const compete = () =>
        coordinator.acquire({
          id: randomUUID(),
          owner: "other",
          ancestors: [],
          kind: "operation",
          roots: [directory.path],
          timeoutMs: 80,
        })
      await expect(compete()).rejects.toThrow("busy")
      process.kill(descendant, "SIGKILL")
      const deadline = Date.now() + 5000
      for (;;) {
        const value = await fs.readFile(`/proc/${descendant}/stat`, "utf8").catch(() => "")
        if (!value || value.slice(value.lastIndexOf(")") + 2).startsWith("Z")) break
        if (Date.now() >= deadline) throw new Error("Known descendant did not terminate")
        await Bun.sleep(10)
      }
      descendant = undefined
      await expect(compete()).rejects.toThrow("busy")
      await expect(owned.stop()).rejects.toThrow("ownership remains uncertain")
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL")
        } catch {}
      }
      await owned.stop().catch(() => {})
      if (claim.processTree?.kind === "linux-subreaper")
        await fs.rm(path.dirname(claim.processTree.receipt), { recursive: true, force: true })
    }
  },
  20000,
)
