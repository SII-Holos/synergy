import path from "node:path"
import { createHash } from "node:crypto"
import { SQL } from "bun"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { SessionExport } from "@ericsanchezok/synergy-harness/session/session-export"
import { SessionImport } from "@ericsanchezok/synergy-harness/session/session-import"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePortable } from "@ericsanchezok/synergy-harness/storage/portable"
import type { RuntimeStorage } from "@ericsanchezok/synergy-harness/lifecycle"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { acceptanceRuntime } from "./runtime"
import type { Settings } from "./settings"
import { atomicJSON, digest, sealEvidence } from "./evidence"
import type { Driver } from "./runner"

type StoreOptions = Parameters<typeof TransactionalStore.open>[0]

async function observer(options: StoreOptions) {
  const sqlite =
    options.backend === "sqlite" ? new Database(options.filename, { readwrite: true, create: false }) : undefined
  const postgres = options.backend === "postgres" ? new SQL(options.url, { max: 1 }) : undefined
  const query = async (statement: string, parameters: Array<string | number> = []): Promise<unknown[]> => {
    if (sqlite) return sqlite.query(statement).all(...parameters)
    let index = 0
    return postgres!.unsafe(
      statement.replace(/\?/g, () => `$${++index}`),
      parameters,
    )
  }
  return {
    query,
    async [Symbol.asyncDispose]() {
      sqlite?.close()
      await postgres?.close()
    },
  }
}

export function persistence(settings: Settings): Driver {
  return async (context) => {
    const namespace = `acceptance_${crypto.randomUUID().replaceAll("-", "")}`
    const filename = path.join(context.directory, "authority.sqlite")
    const options: StoreOptions =
      context.scenario.id === "storage-postgres"
        ? {
            backend: "postgres",
            namespace,
            url: (await Bun.file(settings.postgres!.urlFile).text()).trim(),
            maxConnections: 4,
          }
        : { backend: "sqlite", namespace, filename }
    const storage: RuntimeStorage = {
      kind: "owned",
      async open() {
        const store = await TransactionalStore.open(options)
        return {
          handle: { store, artifactDirectory: path.join(context.directory, "home/.synergy/data") },
          needsValidation: true,
          async activate() {},
        }
      },
    }
    const within = <T>(runtime: Awaited<ReturnType<typeof acceptanceRuntime>>, body: () => Promise<T>) =>
      runtime.runtime.run(() => ScopeContext.provide({ scope: Scope.home(), workspace: null, fn: body }))
    const barriers: string[] = []
    const timeline: Array<Record<string, unknown>> = []
    const states: unknown[] = []
    const operationID = crypto.randomUUID()
    const bytes = Buffer.from(crypto.randomUUID())
    await using first = await acceptanceRuntime(context.directory, settings, storage)
    await using external = await observer(options)
    if (options.backend === "postgres") {
      const rows = await external.query("SELECT current_setting('server_version_num')::integer AS version")
      const version = z.array(z.object({ version: z.coerce.number() })).parse(rows)[0]!.version
      if (version < 180000 || version >= 190000) throw new Error("Local PostgreSQL acceptance requires version 18")
      timeline.push({ stage: "database-version", version, at: Date.now() })
    }
    const identity = await within(first, async () => {
      await Config.updateGlobal({
        resources: { stores: { files: { provider: "local", spec: { namespace: "acceptance" } } } },
      })
      const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
      await WorkspaceContent.write(
        { scopeID: "home", workspaceID: workspace.id },
        { path: "record.txt", data: bytes, expectedVersion: null },
      )
      const a = await Session.create({
        title: "Persistence acceptance",
        workspaceID: workspace.id,
        controlProfile: "full_access",
      })
      const b = await Session.create({
        title: "Shared reference",
        workspaceID: workspace.id,
        controlProfile: "full_access",
      })
      const asset = await Asset.write(bytes, "text/plain", "record.txt")
      await createUserMessage({
        sessionID: b.id,
        noReply: true,
        model: first.model,
        parts: [{ type: "attachment", url: `asset://${asset}`, filename: "record.txt", mime: "text/plain" }],
      })
      return {
        sessionID: a.id,
        siblingID: b.id,
        workspaceID: workspace.id,
        asset,
        assetPath: Asset.filePath(asset),
        messageID: Identifier.ascending("message"),
      }
    })
    const input = {
      sessionID: identity.sessionID,
      messageID: identity.messageID,
      noReply: true,
      model: { providerID: settings.providerID, modelID: settings.modelID },
      parts: [
        { type: "text" as const, text: "Retain the shared record without replying." },
        { type: "attachment" as const, url: `asset://${identity.asset}`, filename: "record.txt", mime: "text/plain" },
      ],
    }
    const transact = (fault?: () => Promise<void>) =>
      Storage.transaction(
        async () => {
          const queued = await SessionInbox.enqueueUser(input, { mode: "task" })
          const [count] = await Storage.readMany<{ count: number }>([["acceptance-counter"]])
          await Storage.write(["acceptance-counter"], { count: (count?.count ?? 0) + 1 })
          if (fault) await fault()
          return { itemID: queued.id, messageID: queued.messageID }
        },
        { operationID, requestHash: digest(JSON.stringify(input)) },
      )
    if (options.backend === "sqlite") {
      await external.query(
        "CREATE TRIGGER acceptance_fail BEFORE INSERT ON storage_records WHEN NEW.kind = 'acceptance-fail' BEGIN SELECT RAISE(ABORT, 'acceptance write failure'); END",
      )
    }
    let failed = false
    try {
      await within(first, () =>
        transact(async () => {
          timeline.push({ stage: "writes-staged", at: Date.now() })
          if (options.backend === "sqlite") await Storage.write(["acceptance-fail"], { fail: true })
          else {
            const hash = createHash("sha256").update(namespace).digest()
            const rows = await external.query(
              "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = ? AND objid::bigint = ? AND objsubid = 2 AND granted",
              [hash.readUInt32BE(0), hash.readUInt32BE(4)],
            )
            const owners = z.array(z.object({ pid: z.coerce.number().int() })).parse(rows)
            if (owners.length !== 1) throw new Error("Owned PostgreSQL connection was not uniquely identified")
            const killed = await external.query("SELECT pg_terminate_backend(?) AS terminated", [owners[0]!.pid])
            if (!z.array(z.object({ terminated: z.boolean() })).parse(killed)[0]?.terminated)
              throw new Error("PostgreSQL connection fault was not triggered")
            timeline.push({ stage: "owner-connection-terminated", pid: owners[0]!.pid, at: Date.now() })
          }
        }),
      )
    } catch (error) {
      if (!(error instanceof Error)) throw error
      failed =
        options.backend === "sqlite"
          ? error.message.includes("acceptance write failure")
          : error.name === "StorageOwnershipError"
      states.push({ interrupted: { name: error.name, message: error.message } })
    } finally {
      if (options.backend === "sqlite") await external.query("DROP TRIGGER acceptance_fail")
    }
    if (!failed) throw new Error("The declared durable-write failure did not occur")
    barriers.push("commit-interrupted")
    const before = await external.query(
      "SELECT body FROM storage_records WHERE namespace = ? AND kind IN ('acceptance-counter', 'acceptance-fail') AND body IS NOT NULL",
      [namespace],
    )
    const inboxBefore = await within(first, () => SessionInbox.list(identity.sessionID))
    if (before.length || inboxBefore.length) throw new Error("Interrupted business transaction published partial state")
    await first[Symbol.asyncDispose]()
    await using second = await acceptanceRuntime(context.directory, settings, storage)
    barriers.push("restarted")
    let discard = true
    const replies: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const submitted: unknown = await request.json()
        if (JSON.stringify(submitted) !== JSON.stringify(input)) return new Response(null, { status: 400 })
        const value = await within(second, () => transact())
        const status = discard ? 503 : 200
        discard = false
        replies.push({ committed: true, status, at: Date.now() })
        return status === 503 ? new Response("Injected lost commit acknowledgement", { status }) : Response.json(value)
      },
    })
    try {
      const submit = () => fetch(server.url, { method: "POST", body: JSON.stringify(input) })
      const lost = await submit()
      if (lost.status !== 503) throw new Error("Commit acknowledgement was not interrupted")
      await lost.text()
      const retry = await submit()
      if (!retry.ok) throw new Error("Idempotent retry did not recover the committed result")
      const result = z.object({ itemID: z.string(), messageID: z.string() }).parse(await retry.json())
      if (result.messageID !== identity.messageID) throw new Error("Retry changed the accepted input identity")
      barriers.push("same-input-retried")
      states.push(result)
    } finally {
      await server.stop(true)
    }
    const archived = await within(second, async () => {
      const materialized = await SessionInbox.materializeNextTask(identity.sessionID)
      if (materialized.status !== "materialized") throw new Error("Committed input could not materialize")
      await SessionInbox.enqueueUser(input, { mode: "task" })
      const pending = await SessionInbox.list(identity.sessionID)
      if (pending.length) throw new Error("A materialized duplicate became runnable again")
      const report = await SessionExport.generate({ sessionID: identity.sessionID, mode: "full" })
      await atomicJSON(path.join(context.directory, "session-export.json"), report)
      const imported = await SessionImport.fromReport(report)
      const messages = await Session.messages({ sessionID: imported.rootSessionID })
      if (messages.filter((message) => message.info.role === "user").length !== 1)
        throw new Error("Session export/import lost or duplicated history")
      barriers.push("archive-restored")
      await Session.remove(identity.sessionID)
      const sibling = await Session.get(identity.siblingID)
      const file = await WorkspaceContent.read({ scopeID: "home", workspaceID: identity.workspaceID }, "record.txt")
      const asset = await Asset.read(identity.asset)
      barriers.push("reference-deleted")
      await createUserMessage({
        sessionID: imported.rootSessionID,
        noReply: true,
        model: second.model,
        parts: [{ type: "text", text: "Continue after the persistence recovery." }],
      })
      const continued = await Session.messages({ sessionID: imported.rootSessionID })
      states.push({ materialized, imported, sibling, messages, continued })
      return {
        imported,
        matches:
          digest(file) === digest(bytes) &&
          asset !== undefined &&
          digest(new Uint8Array(await asset.arrayBuffer())) === digest(bytes),
        continued: continued.filter((message) => message.info.role === "user").length === 2,
      }
    })
    await second[Symbol.asyncDispose]()
    await using third = await acceptanceRuntime(context.directory, settings, storage)
    const final = await within(third, async () => ({
      messages: await Session.messages({ sessionID: archived.imported.rootSessionID }),
      receipt: await Storage.current().store.operationReceipt(operationID),
      sibling: await Session.get(identity.siblingID),
    }))
    const rows = z
      .array(z.object({ body: z.string() }))
      .parse(
        await external.query(
          "SELECT body FROM storage_records WHERE namespace = ? AND kind = 'acceptance-counter' AND body IS NOT NULL",
          [namespace],
        ),
      )
    const counter = z.object({ count: z.number() }).parse(JSON.parse(rows[0]!.body))
    const references = (
      await external.query(
        "SELECT session_id FROM storage_records WHERE namespace = ? AND kind = 'session' AND session_id = ? AND body IS NOT NULL",
        [namespace, identity.siblingID],
      )
    ).length
    const receipts = z
      .array(z.object({ count: z.coerce.number() }))
      .parse(
        await external.query(
          "SELECT COUNT(*) AS count FROM storage_receipts WHERE namespace = ? AND operation_id = ?",
          [namespace, operationID],
        ),
      )[0]!.count
    const storedBytes = new Uint8Array(await Bun.file(identity.assetPath).arrayBuffer())
    const physical = {
      receipts,
      effectCount: counter.count,
      rolledBackCount: before.length,
      remainingReferences: references,
      fileHash: digest(storedBytes),
      expectedHash: digest(bytes),
      database: options.backend,
    }
    const observations = {
      canonicalInputs: archived.imported.messageCount,
      effects: counter.count,
      partialCommits: before.length + inboxBefore.length,
      sharedFilePreserved:
        archived.matches &&
        references > 0 &&
        final.sibling.workspaceID === identity.workspaceID &&
        digest(storedBytes) === digest(bytes),
      continued:
        archived.continued &&
        final.messages.filter((message) => message.info.role === "user").length === 2 &&
        final.receipt !== undefined,
    }
    await within(third, () =>
      StoragePortable.exportFile(Storage.current().store, path.join(context.directory, "authority-export.jsonl")),
    )
    await third[Symbol.asyncDispose]()
    if (options.backend === "postgres") {
      for (const table of [
        "storage_artifact_gc",
        "storage_artifacts",
        "storage_events",
        "storage_receipts",
        "storage_records",
        "storage_nodes",
        "storage_namespaces",
      ])
        await external.query(`DELETE FROM ${table} WHERE namespace = ?`, [namespace])
      const remaining = await external.query("SELECT namespace FROM storage_namespaces WHERE namespace = ?", [
        namespace,
      ])
      if (remaining.length) throw new Error("Acceptance PostgreSQL namespace was not reclaimed")
    }
    await atomicJSON(path.join(context.directory, "cleanup.json"), {
      namespaceRetained: options.backend === "sqlite",
      archiveRetained: true,
      activeRuntimeOwners: 0,
    })
    await Promise.all([
      atomicJSON(path.join(context.directory, "observations.json"), observations),
      atomicJSON(path.join(context.directory, "physical.json"), physical),
      atomicJSON(path.join(context.directory, "product.json"), { states, final }),
      atomicJSON(path.join(context.directory, "transport.json"), { timeline, replies }),
    ])
    return {
      status: "passed",
      model: "not-applicable",
      barriers,
      requests: [],
      evidence: await Promise.all([
        sealEvidence(context.directory, "observations.json", "product"),
        sealEvidence(context.directory, "product.json", "product"),
        sealEvidence(context.directory, "physical.json", "external"),
        sealEvidence(context.directory, "transport.json", "transport"),
        sealEvidence(context.directory, "session-export.json", "product"),
        sealEvidence(context.directory, "authority-export.jsonl", "external"),
        sealEvidence(context.directory, "cleanup.json", "external"),
      ]),
    }
  }
}
