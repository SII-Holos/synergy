import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { DarwinCoalition } from "../../src/process/darwin-coalition"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test.skipIf(process.platform !== "darwin")(
  "a native cohort remains occupied after a double-forked shell leader exits",
  async () => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "locks") })
    const lease = await coordinator.acquire({
      id: randomUUID(),
      owner: "detached-test",
      ancestors: [],
      kind: "process",
      roots: [tmp.path],
    })
    const label = `com.synergy.workspace-test.${randomUUID()}`
    const main = path.join(tmp.path, "main"),
      orphan = path.join(tmp.path, "orphan"),
      gate = path.join(tmp.path, "gate"),
      finish = path.join(tmp.path, "finished")
    const code = `import os,time,subprocess\ndef publish(filename,value):\n with open(filename+'.tmp','w') as f: f.write(value)\n os.replace(filename+'.tmp',filename)\npublish(${JSON.stringify(main)},str(os.getpid()))\nwhile not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)\np=os.fork()\nif p: os._exit(0)\nos.setsid()\np=os.fork()\nif p: os._exit(0)\npublish(${JSON.stringify(orphan)},str(os.getpid()))\nr=subprocess.run(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)','/usr/bin/true'])\ntime.sleep(0.8)\npublish(${JSON.stringify(finish)},str(r.returncode))`
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    const domain = `gui/${process.getuid!()}`
    const plist = path.join(tmp.path, "job.plist")
    const args = ["/usr/bin/env", "-i", "/usr/bin/python3", "-c", code]
    await Bun.write(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${xml(path.join(tmp.path, "stdout"))}</string><key>StandardErrorPath</key><string>${xml(path.join(tmp.path, "stderr"))}</string></dict></plist>`,
    )
    const submit = Bun.spawn(["/bin/launchctl", "bootstrap", domain, plist], { stdout: "ignore", stderr: "pipe" })
    let reference: DarwinCoalition.Reference | undefined
    try {
      const stderr = await new Response(submit.stderr).text()
      expect(await submit.exited, stderr).toBe(0)
      for (let i = 0; i < 300 && !(await Bun.file(main).exists()); i++) await Bun.sleep(10)
      const pid = Number(await fs.readFile(main, "utf8"))
      reference = DarwinCoalition.capture(pid)
      await lease.bindProcess(pid, { descendants: true })
      expect(DarwinCoalition.inspect(reference)).toMatchObject({ state: "active" })
      expect(() => DarwinCoalition.capture(process.pid)).toThrow("independent")
      await Bun.write(gate, "run")
      for (let i = 0; i < 300 && !(await Bun.file(orphan).exists()); i++) await Bun.sleep(10)
      const childPID = Number(await fs.readFile(orphan, "utf8"))
      expect(DarwinCoalition.capture(childPID)).toEqual(reference)
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
      expect(DarwinCoalition.inspect(reference)).toMatchObject({ state: "active" })
      for (let i = 0; i < 300 && !(await Bun.file(finish).exists()); i++) await Bun.sleep(10)
      expect(await Bun.file(finish).text(), await Bun.file(path.join(tmp.path, "stderr")).text()).toBe("0")
      for (let i = 0; i < 300; i++) {
        if (DarwinCoalition.inspect(reference).state === "exited") {
          const writer = await coordinator.acquire({
            id: randomUUID(),
            owner: "other",
            ancestors: [],
            kind: "task",
            roots: [tmp.path],
          })
          await writer.release()
          expect(await coordinator.inspect()).toHaveLength(0)
          return
        }
        await Bun.sleep(10)
      }
      throw new Error("An exited native cohort remained active")
    } finally {
      try {
        if (reference) DarwinCoalition.terminate(reference, "SIGKILL")
      } finally {
        const remove = Bun.spawn(["/bin/launchctl", "bootout", `${domain}/${label}`], {
          stdout: "ignore",
          stderr: "ignore",
        })
        await remove.exited
        await lease.release()
      }
    }
  },
  20_000,
)
