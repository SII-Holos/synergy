import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { buffer, text } from "node:stream/consumers"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ChildProcessClose } from "@ericsanchezok/synergy-harness/process/child-process-close"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { OwnedProcess } from "../../src/process/owned-process"
import { NativePty } from "../../src/process/native-pty"

const nativeTest = test.skipIf(process.platform !== "win32")
const environment = () =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

async function waitForFile(filename: string) {
  const until = Date.now() + 15000
  while (!(await Bun.file(filename).exists())) {
    if (Date.now() >= until) throw new Error("Native child did not publish its marker")
    await Bun.sleep(20)
  }
}

nativeTest(
  "Windows fences activation and preserves complete binary streams",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "started")
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [directory.path],
    })
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: [
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, process.cwd()+':'+process.env.VALUE); for await (const b of Bun.stdin.stream()) process.stdout.write(b); process.stderr.write('tail'); process.exitCode=7`,
      ],
      cwd: directory.path,
      env: { ...environment(), VALUE: "explicit" },
      lease,
    })
    try {
      expect(await Bun.file(marker).exists()).toBe(false)
      expect((await coordinator.inspect())[0]?.processTree?.kind).toBe("windows-job")
      const output = buffer(owned.child.stdout)
      const error = text(owned.child.stderr)
      const done = ChildProcessClose.wait(owned.child)
      await owned.activate()
      const bytes = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
      owned.child.stdin.end(bytes)
      expect((await done).code).toBe(7)
      expect(Buffer.from(await output)).toEqual(bytes)
      expect(await error).toBe("tail")
      expect(await Bun.file(marker).text()).toBe(`${directory.path}:explicit`)
      expect(await coordinator.inspect()).toHaveLength(0)
    } finally {
      await owned.stop()
    }
  },
  30000,
)

for (const terminal of [false, true])
  nativeTest(
    `Windows ${terminal ? "PTY" : "pipe"} descendants retain occupancy after the root exits`,
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
      const descendant = `await Bun.write(${JSON.stringify(marker)},String(process.pid)); setInterval(() => {}, 1000)`
      const root = `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{env:{},stdio:'ignore',detached:true}); child.unref()`
      const owned = await OwnedProcess.prepare({
        command: process.execPath,
        args: ["-e", root],
        cwd: directory.path,
        env: environment(),
        lease,
        pty: terminal ? { cols: 80, rows: 24, library: NativePty.libraryPath() } : undefined,
      })
      owned.child.stdout.resume()
      owned.child.stderr.resume()
      try {
        await owned.activate()
        await waitForFile(marker)
        const pid = Number(await Bun.file(marker).text())
        await Bun.sleep(100)
        await lease.release()
        expect(owned.child.exitCode).toBeNull()
        await expect(
          coordinator.acquire({
            id: randomUUID(),
            owner: "competitor",
            ancestors: [],
            kind: "operation",
            roots: [directory.path],
            timeoutMs: 100,
          }),
        ).rejects.toThrow("busy")
        await owned.stop()
        expect(() => process.kill(pid, 0)).toThrow()
        expect(await coordinator.inspect()).toHaveLength(0)
      } finally {
        await owned.stop()
      }
    },
    30000,
  )

nativeTest(
  "Windows owner crash terminates detached descendants and releases the durable claim",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "descendant")
    const locks = path.join(directory.path, "locks")
    const coordinator = new WorkspaceCoordinator({ directory: locks })
    const filename = path.join(directory.path, "owner.ts")
    const descendant = `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
    const command = `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{env:{},stdio:'ignore',detached:true}); c.unref()`
    await Bun.write(
      filename,
      `
    import { OwnedProcess } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/process/owned-process.ts"))};
    import { WorkspaceCoordinator } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/workspace/coordinator.ts"))};
    const lease=await new WorkspaceCoordinator({directory:${JSON.stringify(locks)}}).acquire({id:crypto.randomUUID(),owner:'crashing',ancestors:[],kind:'process',roots:[${JSON.stringify(directory.path)}]});
    const owned=await OwnedProcess.prepare({command:process.execPath,args:['-e',${JSON.stringify(command)}],cwd:${JSON.stringify(directory.path)},env:process.env,lease});
    owned.child.stdout.resume();owned.child.stderr.resume();await owned.activate();setInterval(()=>{},1000);
  `,
    )
    const owner = Bun.spawn([process.execPath, filename], { env: environment(), stdout: "ignore", stderr: "pipe" })
    const errors = new Response(owner.stderr).text()
    try {
      await waitForFile(marker)
      const pid = Number(await Bun.file(marker).text())
      owner.kill("SIGKILL")
      await owner.exited
      const until = Date.now() + 10000
      while ((await coordinator.inspect()).length) {
        if (Date.now() >= until) throw new Error(`Claim survived owner crash: ${await errors}`)
        await Bun.sleep(25)
      }
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      owner.kill()
      await owner.exited
    }
  },
  30000,
)

nativeTest(
  "Windows cancellation before activation runs no user command",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "must-not-run")
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "owner",
      ancestors: [],
      kind: "process",
      roots: [directory.path],
    })
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'bad')`],
      cwd: directory.path,
      env: environment(),
      lease,
    })
    owned.child.stdout.resume()
    owned.child.stderr.resume()
    await owned.stop()
    await expect(owned.activate()).rejects.toThrow("activation")
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await coordinator.inspect()).toHaveLength(0)
  },
  30000,
)

nativeTest(
  "Windows PTY reports high unsigned exit codes without mistaking them for a running process",
  async () => {
    await using directory = await tmpdir()
    const child = NativePty.spawn({
      command: process.execPath,
      args: [
        "-e",
        `import {dlopen} from 'bun:ffi'; dlopen('kernel32.dll',{ExitProcess:{args:['u32'],returns:'void'}}).symbols.ExitProcess(0xc000013a)`,
      ],
      cwd: directory.path,
      env: environment(),
    })
    try {
      child.stdout.resume()
      expect(await child.exited).toBe(0xc000013a)
    } finally {
      child.close()
    }
  },
  30000,
)
