import { expect, test } from "bun:test"
import path from "node:path"
import { buffer, text } from "node:stream/consumers"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ChildProcessClose } from "@ericsanchezok/synergy-harness/process/child-process-close"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { OwnedProcess } from "../../src/process/owned-process"

const nativeTest = test.skipIf(!["darwin", "linux"].includes(process.platform))

nativeTest(
  "activation records ownership before any command runs and preserves bytes, cwd, env and exit",
  async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "started")
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: [
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, process.cwd()+':'+process.env.PROBE); for await (const b of Bun.stdin.stream()) process.stdout.write(b); process.stderr.write('err'); process.exitCode=7`,
      ],
      cwd: tmp.path,
      env: { PROBE: "ok" },
      lease,
    })
    try {
      expect(await Bun.file(marker).exists()).toBe(false)
      expect((await coordinator.inspect())[0].processBound).toBe(true)
      const output = buffer(owned.child.stdout)
      const error = text(owned.child.stderr)
      const done = ChildProcessClose.wait(owned.child)
      await owned.activate()
      const bytes = Buffer.alloc(1024 * 1024)
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
      owned.child.stdin.end(bytes)
      const closed = await done
      expect(closed.code).toBe(7)
      const actual = Buffer.from(await output)
      expect(actual.length).toBe(bytes.length)
      expect(Bun.CryptoHasher.hash("sha256", actual, "hex")).toBe(Bun.CryptoHasher.hash("sha256", bytes, "hex"))
      expect(await error).toBe("err")
      expect(await Bun.file(marker).text()).toBe(`${tmp.path}:ok`)
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      await owned.stop()
    }
  },
  20000,
)

nativeTest(
  "an empty-env detached descendant retains writer occupancy after closing its pipes",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const marker = path.join(tmp.path, "detached")
    const code = `import os,time\np=os.fork()\nif p: os._exit(0)\nos.setsid()\np=os.fork()\nif p: os._exit(0)\nos.close(0);os.close(1);os.close(2)\nopen(${JSON.stringify(marker)},'w').write('ready')\ntime.sleep(20)`
    const owned = await OwnedProcess.prepare({
      command: "/usr/bin/env",
      args: ["-i", "/usr/bin/python3", "-c", code],
      cwd: tmp.path,
      env: {},
      lease,
    })
    try {
      const done = ChildProcessClose.wait(owned.child)
      await owned.activate()
      for (let i = 0; i < 300; i++) {
        if (
          (await Bun.file(marker)
            .text()
            .catch(() => "")) === "ready"
        )
          break
        await Bun.sleep(10)
      }
      expect(await Bun.file(marker).text()).toBe("ready")
      await lease.release()
      await expect(
        coordinator.acquire({
          id: randomUUID(),
          owner: "other",
          ancestors: [],
          kind: "task",
          roots: [tmp.path],
          timeoutMs: 100,
        }),
      ).rejects.toThrow("busy")
      expect(owned.child.exitCode).toBeNull()
      await owned.stop()
      await done
      const next = await coordinator.acquire({
        id: randomUUID(),
        owner: "other",
        ancestors: [],
        kind: "task",
        roots: [tmp.path],
      })
      await next.release()
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      await owned.stop()
    }
  },
  20000,
)

nativeTest(
  "cancelled preactivation never starts the command",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const marker = path.join(tmp.path, "unexpected")
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'bad')`],
      cwd: tmp.path,
      env: {},
      lease,
    })
    await owned.stop()
    await expect(owned.activate()).rejects.toThrow()
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await coordinator.inspect()).toHaveLength(0)
  },
  20000,
)

nativeTest(
  "missing executables fail activation and release the recorded process claim",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const owned = await OwnedProcess.prepare({
      command: path.join(tmp.path, "missing"),
      args: [],
      cwd: tmp.path,
      env: {},
      lease,
    })
    try {
      await expect(owned.activate()).rejects.toThrow()
      await owned.stop()
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      await owned.stop()
    }
  },
  20000,
)

test.skipIf(process.platform !== "darwin")(
  "supervisor death cannot release an escaped descendant's claim",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const marker = path.join(tmp.path, "ready")
    const code = `import os,time\np=os.fork()\nif p: os._exit(0)\nos.setsid()\np=os.fork()\nif p: os._exit(0)\nos.close(0);os.close(1);os.close(2)\nopen(${JSON.stringify(marker)},'w').write('ready')\ntime.sleep(20)`
    const owned = await OwnedProcess.prepare({
      command: "/usr/bin/env",
      args: ["-i", "/usr/bin/python3", "-c", code],
      cwd: tmp.path,
      env: {},
      lease,
    })
    try {
      const workerPID = (await coordinator.inspect())[0].pid
      const done = ChildProcessClose.wait(owned.child)
      await owned.activate()
      for (let i = 0; i < 300; i++) {
        if (
          (await Bun.file(marker)
            .text()
            .catch(() => "")) === "ready"
        )
          break
        await Bun.sleep(10)
      }
      expect(await Bun.file(marker).text()).toBe("ready")
      process.kill(workerPID, "SIGKILL")
      await Bun.sleep(80)
      expect(owned.child.alive()).toBe(true)
      await lease.release()
      await expect(
        coordinator.acquire({
          id: randomUUID(),
          owner: "other",
          ancestors: [],
          kind: "task",
          roots: [tmp.path],
          timeoutMs: 80,
        }),
      ).rejects.toThrow("busy")
      await owned.stop()
      await done
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      await owned.stop()
    }
  },
  20000,
)

nativeTest(
  "stopping a process with an unread full output pipe remains bounded",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: [
        "-e",
        "const b=Buffer.alloc(65536); while(true) { if (!process.stdout.write(b)) await new Promise(r=>process.stdout.once('drain',r)); }",
      ],
      cwd: tmp.path,
      env: {},
      lease,
    })
    try {
      await owned.activate()
      for (let i = 0; i < 300 && owned.child.stdout.readableLength < 65536; i++) await Bun.sleep(10)
      expect(owned.child.stdout.readableLength).toBeGreaterThanOrEqual(65536)
      const stop = owned.stop()
      const outcome = await Promise.race([stop.then(() => "stopped"), Bun.sleep(3000).then(() => "blocked")])
      expect(outcome).toBe("stopped")
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      owned.child.stdout.resume()
      owned.child.stderr.resume()
      await owned.stop()
    }
  },
  10000,
)

nativeTest(
  "a Runtime crash stops its owned tree and another Runtime can reclaim the Workspace",
  async () => {
    await using tmp = await tmpdir()
    const lockDirectory = path.join(tmp.path, "locks")
    const marker = path.join(tmp.path, "owner-ready")
    const filename = path.join(tmp.path, "owner.ts")
    const processModule = new URL("../../src/process/owned-process.ts", import.meta.url).href
    const coordinatorModule = new URL("../../src/workspace/coordinator.ts", import.meta.url).href
    await Bun.write(
      filename,
      `import {OwnedProcess} from ${JSON.stringify(processModule)}; import {WorkspaceCoordinator} from ${JSON.stringify(coordinatorModule)}; const c=new WorkspaceCoordinator({directory:${JSON.stringify(lockDirectory)}}); const lease=await c.acquire({id:crypto.randomUUID(),owner:'crashed',ancestors:[],kind:'process',roots:[${JSON.stringify(tmp.path)}]}); const p=await OwnedProcess.prepare({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:${JSON.stringify(tmp.path)},env:{},lease}); await p.activate(); await Bun.write(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000);`,
    )
    const parent = Bun.spawn([process.execPath, filename], { stdout: "ignore", stderr: "pipe" })
    const error = new Response(parent.stderr).text()
    try {
      for (let i = 0; i < 500; i++) {
        if (
          (await Bun.file(marker)
            .text()
            .catch(() => "")) === "ready"
        )
          break
        if (parent.exitCode !== null) throw new Error(await error)
        await Bun.sleep(10)
      }
      expect(await Bun.file(marker).text()).toBe("ready")
      const coordinator = new WorkspaceCoordinator({ directory: lockDirectory })
      expect(await coordinator.inspect()).toHaveLength(1)
      parent.kill("SIGKILL")
      await parent.exited
      const next = await coordinator.acquire({
        id: randomUUID(),
        owner: "survivor",
        ancestors: [],
        kind: "task",
        roots: [tmp.path],
        timeoutMs: 5000,
      })
      await next.release()
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL")
      await parent.exited
    }
  },
  15000,
)
