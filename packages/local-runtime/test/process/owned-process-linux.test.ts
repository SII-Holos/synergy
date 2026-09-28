import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { OwnedProcess } from "../../src/process/owned-process"
import { OwnedProtocol } from "../../src/process/owned-protocol"
import type { Socket } from "node:net"

const nativeTest = test.skipIf(process.platform !== "linux")

async function errnoFixture(mode: string, jit = "0") {
  await using directory = await tmpdir()
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/linux-tree-errno.ts"), directory.path, mode],
    { cwd: directory.path, env: { ...process.env, BUN_JSC_useJIT: jit }, stdout: "pipe", stderr: "pipe" },
  )
  const output = new Response(child.stdout).text()
  const error = new Response(child.stderr).text()
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error("Linux errno fixture did not finish")), 6000)
  try {
    const code = await Promise.race([child.exited, deadline.promise])
    expect(code, await error).toBe(0)
    return JSON.parse(await output)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}

for (const jit of ["0", "1"]) {
  for (const children of ["empty", "held"]) {
    nativeTest(
      `Linux completion retains the kernel result across FFI return work (${jit}, ${children})`,
      async () => {
        expect(await errnoFixture(children, jit)).toEqual({ state: "exited", held: children === "held" })
      },
      10000,
    )
  }
}

nativeTest(
  "incompatible Linux native libraries fail before command activation",
  async () => {
    expect(await errnoFixture("missing-symbols")).toEqual({ state: "unavailable" })
  },
  10000,
)

nativeTest(
  "Linux pidfd errors retain their own errno across FFI return work",
  async () => {
    expect(await errnoFixture("pidfd-errors")).toEqual({ open: -22, signal: -9, close: -9 })
  },
  10000,
)

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
    let control: Socket | undefined
    const messages = OwnedProtocol.messages
    const protocol = spyOn(OwnedProtocol, "messages").mockImplementation((socket, receive, failed) => {
      control = socket
      return messages(socket, receive, failed)
    })
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: ["-e", root],
      cwd: directory.path,
      env: {},
      lease,
    }).finally(() => protocol.mockRestore())
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
      const transport = Object.assign(new Error("control connection reset"), { code: "ECONNRESET" })
      control!.emit("error", transport)
      const failure = await owned.completion.then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({
        message: expect.stringContaining("ownership remains uncertain"),
        cause: transport,
      })
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
