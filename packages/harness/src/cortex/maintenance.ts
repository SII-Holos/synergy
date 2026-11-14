import { Cortex } from "./manager"
import { CortexTypes } from "./types"
import { CortexMaintenanceHolds } from "./maintenance-holds"
import { Session } from "../session"
import { SessionRecords } from "../session/records"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Global } from "../global"
import { initializeSqliteEngine } from "../storage/sqlite-engine"

async function* activeSessions() {
  for await (const row of Storage.records<Record<string, unknown>>({ kind: "session", limit: 128 })) {
    const cortex = row.value.cortex
    if (cortex === undefined) continue
    const status = CortexTypes.TaskStatus.safeParse(
      cortex && typeof cortex === "object" && "status" in cortex ? cortex.status : undefined,
    )
    if (!status.success)
      throw new RuntimeMaintenance.Blocked({
        message: "An unknown Cortex status cannot establish native writer drainage",
        requirements: [
          {
            code: "cortex_status_unknown",
            owner: "cortex",
            label: "Reconcile the unknown Cortex writer schema",
            recoverable: true,
          },
        ],
      })
    if (CortexTypes.isTerminalStatus(status.data)) continue
    yield await SessionRecords.read(row.key)
  }
}

async function* postorderSessions(signal: AbortSignal) {
  const parent = path.join(Global.Path.cache, "cortex-maintenance")
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(parent, "order-"))
  initializeSqliteEngine()
  const database = new Database(path.join(directory, "order.sqlite"))
  try {
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE pending (id TEXT PRIMARY KEY,parent TEXT); CREATE INDEX pending_parent ON pending(parent)",
    )
    using insert = database.prepare("INSERT INTO pending VALUES (?,?)")
    for await (const session of activeSessions()) {
      signal.throwIfAborted()
      insert.run(session.id, session.parentID ?? null)
    }
    using leaf = database.prepare<{ id: string }, []>(
      "SELECT p.id FROM pending p WHERE NOT EXISTS(SELECT 1 FROM pending c WHERE c.parent=p.id) ORDER BY p.id LIMIT 1",
    )
    using remaining = database.prepare("SELECT 1 FROM pending LIMIT 1")
    using remove = database.prepare("DELETE FROM pending WHERE id=?")
    for (;;) {
      signal.throwIfAborted()
      const next = leaf.get()
      if (!next) {
        if (remaining.get())
          throw new RuntimeMaintenance.Blocked({
            message: "Cortex maintenance cannot suspend a cyclic native parent graph",
          })
        return
      }
      yield await Session.get(next.id)
      remove.run(next.id)
    }
  } finally {
    database.close(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export function registerCortexMaintenanceOwner() {
  RuntimeMaintenance.register("cortex", {
    version: 1,
    order: 20,
    async suspend(context) {
      for await (const session of postorderSessions(context.signal)) {
        context.signal.throwIfAborted()
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.suspendForMaintenance(session.id, context),
        })
      }
    },
    async drain(context) {
      context.signal.throwIfAborted()
      await Cortex.drain()
    },
    async inspect(context) {
      const requirements: RuntimeMaintenance.Requirement[] = []
      for await (const session of activeSessions()) {
        context.signal.throwIfAborted()
        const requirement = await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.inspectMaintenance(session.id, context),
        })
        if (requirement) requirements.push(requirement)
      }
      return requirements
    },
    async release(context) {
      for await (const row of CortexMaintenanceHolds.list(context.maintenanceID)) {
        context.signal.throwIfAborted()
        const session = await Session.get(row.sessionID)
        if (session.scope.id !== row.scopeID || session.cortex?.taskID !== row.taskID)
          throw new RuntimeMaintenance.Blocked({
            message: "Cortex maintenance index no longer matches its canonical task",
          })
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: () => Cortex.releaseMaintenance(session.id, context),
        })
      }
    },
  })
}
