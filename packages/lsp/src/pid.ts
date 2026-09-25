import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { AtomicFile } from "@ericsanchezok/synergy-harness/storage/atomic-file"
import { processStartIdentity } from "@ericsanchezok/synergy-util/process-identity"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"

export namespace LSPPid {
  const Record = z.object({
    pid: z.number().int().positive(),
    identity: z.string(),
    ownerPID: z.number().int().positive(),
    ownerIdentity: z.string(),
    hostID: z.string(),
    token: z.string(),
  })
  type Record = z.infer<typeof Record>
  const File = z.object({ version: z.literal(2), processes: z.array(Record) })

  export async function track(pid: number): Promise<() => Promise<void>> {
    const filename = Global.Path.lspPids
    const [identity, ownerIdentity, hostID] = await Promise.all([
      processStartIdentity(pid),
      processStartIdentity(process.pid),
      RuntimeContext.current().host.workspaceLocation?.hostID(),
    ])
    if (!identity || !ownerIdentity || !hostID) return async () => {}
    const record: Record = { pid, identity, ownerPID: process.pid, ownerIdentity, hostID, token: randomUUID() }
    await mutate(filename, (records) => [...records.filter((item) => item.pid !== pid), record])
    let release: Promise<void> | undefined
    return () => (release ??= mutate(filename, (records) => records.filter((item) => item.token !== record.token)))
  }

  export async function cleanupOrphans() {
    const filename = Global.Path.lspPids
    const hostID = await RuntimeContext.current().host.workspaceLocation?.hostID()
    if (!hostID) return
    await mutate(filename, async (records) => {
      const retained: Record[] = []
      for (const record of records) {
        if (record.hostID !== hostID || (await ownerAlive(record))) {
          retained.push(record)
          continue
        }
        if (!ProcessInspection.alive(record.pid)) continue
        if ((await processStartIdentity(record.pid)) !== record.identity) {
          retained.push(record)
          continue
        }
        signal(record.pid, "SIGTERM")
        const deadline = Date.now() + 1_000
        while (ProcessInspection.alive(record.pid) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25))
        if (
          ProcessInspection.alive(record.pid) &&
          (await processStartIdentity(record.pid)) === record.identity &&
          !(await ownerAlive(record))
        )
          signal(record.pid, "SIGKILL")
      }
      return retained
    })
  }

  function signal(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }

  async function ownerAlive(record: Record) {
    if (!ProcessInspection.alive(record.ownerPID)) return false
    const identity = await processStartIdentity(record.ownerPID)
    return identity === undefined || identity === record.ownerIdentity
  }

  async function mutate(filename: string, update: (records: Record[]) => Record[] | Promise<Record[]>) {
    return withFileLock({ directory: path.join(path.dirname(filename), ".locks"), key: "lsp-processes" }, async () => {
      const raw = await Bun.file(filename)
        .json()
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
          throw error
        })
      // PID-only legacy files cannot establish ownership or protect recycled PIDs.
      const records = raw === undefined || Array.isArray(raw) ? [] : File.parse(raw).processes
      const next = await update(records)
      await AtomicFile.writeJsonAtomic(filename, JSON.stringify({ version: 2, processes: next }), { private: true })
    })
  }
}
