import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationAuthorityHistory } from "../authority-history"
import {
  OrganizationProtocol,
  OrganizationExecutionProtocol as Execution,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const policies = new Set(["info", "accounts", "projects", "project-members"])
const modelProtocols = new Set(["openai-compatible", "anthropic-compatible", "fixed-http", "mcp-http", "mcp-sse"])
const indexes = new Set(["session-creators", "session-visibility", "hosted-runtimes"])
type Mode = "metadata" | "exact" | "runtime"
type Reference = z.infer<typeof OrganizationInstallationReference>
type Frame = {
  database: Database
  target: Reference
  namespaceHash: string
  sources: Map<string, { proof: NamespaceRetirement.Inspection; reference: NamespaceRetirement.Reference }>
  assertTarget(): void
  assert(): void
}
const inspections = new WeakMap<OrganizationRecoveryWriters.Inspection, Frame>()
const sealed = new WeakMap<StoreTransaction, { frame: Frame; failed: boolean }>()
const mutations = RuntimeContext.createAsyncContext<{
  frame: Frame
  key?: string[]
  consumed: boolean
  open: boolean
}>()

function frame(evidence: OrganizationRecoveryWriters.Inspection) {
  const selected = inspections.get(evidence)
  if (!selected) blocked("missing original writer inspection")
  selected.assert()
  return selected
}
function sourceRow(selected: Frame, key: string[]) {
  const row = selected.database
    .query<{ value: string; mode: Mode }, [string]>("SELECT value,mode FROM records WHERE key=?")
    .get(JSON.stringify(key))
  return row && { value: JSON.parse(row.value) as unknown, mode: row.mode }
}
function sourceValue<T>(selected: Frame, schema: z.ZodType<T>, key: string[]) {
  const row = sourceRow(selected, key)
  if (!row) blocked("missing H1 owner record")
  return schema.parse(row.value)
}
function sourceRuntime(selected: Frame, id: string) {
  const runtime = sourceValue(selected, Record.RuntimeRegistration, Keys.runtime(id))
  const deployment = sourceValue(selected, OrganizationProtocol.Deployment, Keys.deployment())
  const source = selected.sources.get(id)
  if (source && hash(NamespaceRetirement.inspect(source.proof)) !== hash(source.reference))
    blocked("changed permanent namespace source")
  const identity = source?.reference.namespace.identity
  if (
    runtime.runtimeID !== id ||
    runtime.runtimeKind !== "hosted" ||
    !identity ||
    identity.orgID !== deployment.orgID ||
    identity.deploymentIncarnation !== deployment.deploymentIncarnation ||
    runtime.orgID !== identity.orgID ||
    runtime.deploymentIncarnation !== identity.deploymentIncarnation ||
    runtime.publicKey !== identity.publicKey
  )
    blocked("Hosted identity differs from its H1 deployment and permanent source")
  return runtime
}
function sourceSession(selected: Frame, id: string) {
  const session = sourceValue(selected, Record.SessionDirectory, Keys.session(id))
  const runtime = sourceRuntime(selected, session.driverRuntimeID)
  if (
    session.sessionID !== id ||
    session.orgID !== runtime.orgID ||
    session.handoffID ||
    session.retainedExecutionGrants !== 0
  )
    blocked("unreconciled Session binding or retained execution")
  return session
}
function sourceResource(selected: Frame, orgID: string, id: string) {
  const resource = sourceValue(selected, Record.Resource, Keys.resource(orgID, id))
  const deployment = sourceValue(selected, OrganizationProtocol.Deployment, Keys.deployment())
  if (
    resource.orgID !== orgID ||
    resource.orgID !== deployment.orgID ||
    resource.resourceID !== id ||
    !modelProtocols.has(resource.configuration.protocol)
  )
    blocked("external resource owner")
  return resource
}
function selection(selected: Frame, orgID: string, value: Execution.Selection) {
  if (value.infrastructure.workspace || value.infrastructure.environment) blocked("Session infrastructure")
  for (const role of Execution.resourceRoles(value))
    if (Resource.kind(sourceResource(selected, orgID, role.resourceID).configuration) !== role.kind)
      blocked("resource selection owner")
}
function classify(selected: Frame, key: string[], value: unknown): Mode {
  const [root, kind] = key
  if (root !== "organization") {
    if (!root || !safeRoots.has(root)) blocked("native " + (root ?? "owner"))
    if (root === "organization-api-tokens") return "exact"
    return "metadata"
  }
  const marker = kind && schemaMarkers.get(kind)
  if (
    marker &&
    key.length === 2 &&
    (hash(value) === hash(marker) ||
      (kind === "transcript-window-schema" && hash(value) === hash({ schemaVersion: 2 })))
  )
    return "metadata"
  if (kind && serviceRecords.has(kind)) return policies.has(kind) ? "exact" : "metadata"
  if (kind === "runtimes") {
    const runtime = Record.RuntimeRegistration.parse(value)
    if (key.length !== 3 || key[2] !== runtime.runtimeID || runtime.runtimeKind !== "hosted")
      blocked("member or malformed Runtime")
    const source = selected.sources.get(runtime.runtimeID)
    if (!source) blocked("unproved Hosted Runtime")
    const expected = sourceRuntime(selected, runtime.runtimeID)
    const published = Record.RuntimeRegistration.parse({
      ...expected,
      deploymentIncarnation: selected.target.incarnation,
      revision: expected.revision + 1,
    })
    if (hash(runtime) !== hash(expected) && hash(runtime) !== hash(published))
      blocked("Hosted registration changed outside publication")
    return "runtime"
  }
  if (kind === "runtime-connections") {
    const connection = Record.RuntimeConnection.parse(value)
    const identity = connection.handshake
    const source = selected.sources.get(identity.runtimeID)
    if (
      key.length !== 3 ||
      key[2] !== identity.runtimeID ||
      identity.runtimeKind !== "hosted" ||
      !source ||
      identity.orgID !== source.reference.namespace.identity.orgID ||
      identity.deploymentIncarnation !== source.reference.namespace.identity.deploymentIncarnation
    )
      blocked("unknown connection observation")
    return "metadata"
  }
  if (kind === "runtime-tickets") {
    const ticket = Record.RuntimeTicket.parse(value)
    const registration = sourceRuntime(selected, ticket.runtimeID)
    if (
      key.length !== 3 ||
      key[2] !== ticket.tokenHash ||
      !ticket.consumed ||
      ticket.consumed.runtimeID !== registration.runtimeID ||
      ticket.consumed.publicKey !== registration.publicKey ||
      ticket.consumed.orgID !== registration.orgID ||
      ticket.consumed.deploymentIncarnation !== registration.deploymentIncarnation
    )
      blocked("unsettled Runtime enrollment")
    return "metadata"
  }
  if (kind === "sessions") {
    const session = Record.SessionDirectory.parse(value)
    if (
      key.length !== 3 ||
      key[2] !== session.sessionID ||
      hash(session) !== hash(sourceSession(selected, session.sessionID))
    )
      blocked("unreconciled Session binding or retained execution")
    return "exact"
  }
  if (kind === "session-resources") {
    const resources = Record.SessionResources.parse(value)
    const session = sourceSession(selected, resources.sessionID)
    if (
      hash(key) !== hash(Keys.sessionResources(session.sessionID)) ||
      resources.orgID !== session.orgID ||
      !resources.selection
    )
      blocked("Session resource owner")
    selection(selected, resources.orgID, resources.selection)
    return "exact"
  }
  if (kind === "resources") {
    const resource = Record.Resource.parse(value)
    if (
      hash(key) !== hash(Keys.resource(resource.orgID, resource.resourceID)) ||
      hash(resource) !== hash(sourceResource(selected, resource.orgID, resource.resourceID))
    )
      blocked("external resource owner")
    return "exact"
  }
  if (kind === "resource-secrets") {
    const secret = Record.ResourceSecret.parse(value)
    const resource = sourceResource(selected, secret.orgID, secret.resourceID)
    if (key.length !== 3 || key[2] !== resource.secretID) blocked("resource credential owner")
    return "exact"
  }
  if (kind === "resource-grants") {
    const grant = Record.ResourceGrant.parse(value)
    sourceResource(selected, grant.orgID, grant.resourceID)
    if (hash(key) !== hash(Keys.resourceGrant(grant.orgID, grant.resourceID, grant.subject)))
      blocked("resource grant owner")
    return "exact"
  }
  if (kind === "resource-access") {
    const access = Record.ResourceAccess.parse(value)
    const orgID = key[2]
    if (!orgID) blocked("resource access owner")
    const resource = sourceResource(selected, orgID, access.resourceID)
    const grant = sourceValue(
      selected,
      Record.ResourceGrant,
      Keys.resourceGrant(orgID, access.resourceID, access.subject),
    )
    const prefix =
      access.subject.kind === "project"
        ? Keys.projectResources(orgID, access.subject.id)
        : Keys.accountResources(
            orgID,
            access.subject.id,
            resource.scope.kind === "project" ? resource.scope.projectID : undefined,
          )
    if (
      !grant.enabled ||
      hash(grant.subject) !== hash(access.subject) ||
      hash(key) !== hash([...prefix, access.resourceID])
    )
      blocked("resource access owner")
    return "exact"
  }
  if (kind === "command-states") {
    if (Record.CommandState.parse(value).pendingAttemptID) blocked("pending command")
    blocked("unreconciled command owner")
  }
  if (kind && indexes.has(kind)) {
    if (kind === "hosted-runtimes") {
      const index = Record.RuntimeIndex.parse(value)
      sourceRuntime(selected, index.runtimeID)
      if (key.length !== 3 || key[2] !== index.runtimeID) blocked("Hosted index owner")
    } else {
      const session = sourceSession(selected, Record.SessionIndex.parse(value).sessionID)
      const expected =
        kind === "session-creators"
          ? Keys.creatorSession(session.projectID, session.creatorID, session.sessionID)
          : Keys.visibleSession(session.shareState, session.projectID, session.sessionID)
      if (hash(key) !== hash(expected)) blocked("Session index owner")
    }
    return "exact"
  }
  blocked("organization " + (kind ?? "owner"))
}

const safeRoots = new Set([
  "meta",
  "storage_authority_journal",
  "runtime_maintenance",
  "organization-recovery",
  "organization-api-tokens",
])
const schemaMarkers = new Map([
  ["execution-grant-index-schema", { version: 1, complete: true }],
  ["execution-control-index-schema", { version: 1, complete: true }],
  ["transcript-schema", { schemaVersion: 1 }],
  ["transcript-window-schema", { schemaVersion: 3 }],
  ["task-projection-schema", { schemaVersion: 1 }],
])
const serviceRecords = new Set([
  "deployment",
  "info",
  "signing-identity",
  "accounts",
  "login-names",
  "logins",
  "authorization-codes",
  "client-grants",
  "client-access",
  "client-refresh",
  "invites",
  "invite-catalog",
  "invite-receipts",
  "resets",
  "bootstrap",
  "projects",
  "project-members",
  "project-access",
])
function blocked(category: string): never {
  throw new RuntimeMaintenance.Blocked({ message: "Organization recovery requires reconciliation for " + category })
}

export namespace OrganizationRecoveryWriters {
  export interface Inspection {
    readonly kind: "organization-recovery-writers"
  }
  export async function withReconciled<T>(
    input: {
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
      target: Reference
      sources: readonly NamespaceRetirement.Inspection[]
      namespace: { directory: string; expected: StorageCheckpoint.Manifest }
      keys: VaultKeyProvider
      signal?: AbortSignal
    },
    body: (evidence: Inspection) => Promise<T>,
  ) {
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const target = OrganizationInstallationReference.parse(structuredClone(input.target))
    const namespace = {
      directory: input.namespace.directory,
      expected: StorageCheckpoint.Manifest.parse(input.namespace.expected),
    }
    const keys = Object.freeze({
      current: input.keys.current.bind(input.keys),
      resolve: input.keys.resolve.bind(input.keys),
    })
    const signal = input.signal
    const proofs = [...input.sources]
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const configuration = hash(store.options)
    const artifactDirectory = primary.artifactDirectory
    let open = true
    const sources: Frame["sources"] = new Map()
    for (const proof of proofs) {
      const reference = NamespaceRetirement.inspect(proof)
      const identity = reference.namespace.identity
      if (
        reference.namespace.owner !== "organization-runtime" ||
        identity.kind !== "hosted" ||
        !identity.runtimeID ||
        sources.has(identity.runtimeID)
      )
        blocked("duplicate or unknown namespace owner")
      if (
        reference.target.installationID !== target.installationID ||
        reference.target.incarnation !== target.incarnation ||
        hash(reference.target.request) !== target.requestHash ||
        reference.target.request.restoreID !== target.restoreID ||
        reference.target.request.sourceHash !== target.sourceHash
      )
        blocked("foreign original installation")
      sources.set(identity.runtimeID, { proof, reference })
    }
    const assertTarget = () => {
      signal?.throwIfAborted()
      if (!open) blocked("writer callback has ended")
      HomeRestoration.assertRequest(permit, request)
      HomeRestoration.assertInstalledOwner(permit)
      const info = HomeRestoration.describe(permit)
      if (
        info.installationID !== target.installationID ||
        info.incarnation !== target.incarnation ||
        info.restoreID !== target.restoreID ||
        info.requestHash !== target.requestHash ||
        info.sourceHash !== target.sourceHash ||
        z.object({ nativeHash: z.string() }).parse(request.payload).nativeHash !== target.nativeHash
      )
        blocked("another native target")
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        Storage.current().store !== store ||
        primary.store !== store ||
        hash(store.options) !== configuration ||
        primary.artifactDirectory !== artifactDirectory ||
        Storage.current().artifactDirectory !== artifactDirectory ||
        primary.artifactObjects ||
        Storage.current().artifactObjects ||
        store.hasUnpublishedOwners()
      )
        blocked("changed native target Store")
    }
    const assert = () => {
      assertTarget()
      for (const source of sources.values())
        if (hash(NamespaceRetirement.inspect(source.proof)) !== hash(source.reference))
          blocked("changed permanent namespace source")
    }
    assert()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-recovery-writers-"))
    const database = new Database(path.join(directory, "writers.sqlite"))
    const selected: Frame = { database, target, namespaceHash: hash(namespace.expected), sources, assertTarget, assert }
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT NOT NULL,mode TEXT NOT NULL)",
      )
      using insert = database.query("INSERT INTO records VALUES(?,?,'metadata')")
      let unsafe: string | undefined
      for await (const entry of StorageCheckpoint.entries({ ...namespace, keys, signal })) {
        assertTarget()
        if (entry.type === "record") insert.run(JSON.stringify(entry.key), JSON.stringify(entry.value))
        else if (entry.type === "event") unsafe = "unreconciled historical events"
        else if (
          entry.type === "receipt" &&
          !entry.operationID.startsWith("storage-checkpoint:") &&
          !/^runtime-maintenance-begin:[a-f0-9]{64}$/.test(entry.operationID)
        )
          unsafe = "unclassified operation receipts"
      }
      assert()
      if (unsafe) blocked(unsafe)
      using rows = database.query<{ key: string; value: string }, []>("SELECT key,value FROM records ORDER BY key")
      using update = database.query("UPDATE records SET mode=? WHERE key=?")
      for (const row of rows.iterate()) {
        assertTarget()
        update.run(classify(selected, JSON.parse(row.key), JSON.parse(row.value)), row.key)
      }
      const evidence: Inspection = Object.freeze({ kind: "organization-recovery-writers" })
      inspections.set(evidence, selected)
      await assertReconciled(evidence)
      const result = await body(evidence)
      assert()
      return result
    } finally {
      open = false
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  export function inspect(evidence: Inspection) {
    const selected = frame(evidence)
    return {
      version: 1 as const,
      target: OrganizationInstallationReference.parse(selected.target),
      namespaceHash: selected.namespaceHash,
      hosted: selected.sources.size,
    }
  }
  export function* hosted(evidence: Inspection) {
    const selected = frame(evidence)
    using rows = selected.database.query<{ value: string }, []>(
      "SELECT value FROM records WHERE mode='runtime' ORDER BY key",
    )
    for (const row of rows.iterate()) {
      selected.assertTarget()
      const registration = Record.RuntimeRegistration.parse(JSON.parse(row.value))
      if (registration.runtimeKind !== "hosted") blocked("member writer")
      const source = selected.sources.get(registration.runtimeID)
      if (!source) blocked("missing permanent Hosted source")
      sourceRuntime(selected, registration.runtimeID)
      yield { sourceReferenceHash: hash(source.reference), registration }
    }
  }
  export async function assertReconciled(evidence: Inspection) {
    const selected = frame(evidence)
    return Storage.snapshot(async (tx) => {
      let count = 0
      const found = new Set<string>()
      for await (const entry of tx.exportEntries()) {
        selected.assertTarget()
        if (entry.type === "record") {
          const mode = classify(selected, entry.key, entry.value)
          if (mode !== "metadata") {
            const source = sourceRow(selected, entry.key)
            if (!source || (mode !== "runtime" && hash(source.value) !== hash(entry.value)))
              blocked("H0 facts differ from the actual H1 owner")
            count++
            if (mode === "runtime") found.add(Record.RuntimeRegistration.parse(entry.value).runtimeID)
          }
        } else if (entry.type === "event") blocked("unreconciled historical events")
        else if (
          entry.type === "receipt" &&
          !entry.operationID.startsWith("storage-checkpoint:") &&
          !/^runtime-maintenance-begin:[a-f0-9]{64}$/.test(entry.operationID)
        )
          blocked("unclassified operation receipts")
      }
      const expected = selected.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM records WHERE mode<>'metadata'")
        .get()!.count
      if (
        count !== expected ||
        found.size !== selected.sources.size ||
        [...selected.sources.keys()].some((id) => !found.has(id))
      )
        blocked("incomplete H1 canonical roster or owner facts")
      selected.assert()
      return inspect(evidence)
    })
  }
  export async function publish(evidence: Inspection, tx: StoreTransaction) {
    const selected = frame(evidence)
    if (!Storage.inWriteTransaction() || Storage.current().transaction !== tx)
      blocked("another publication transaction")
    return Storage.transaction(
      async () => {
        await assertReconciled(evidence)
        const previous = sealed.get(tx)
        if (previous && (previous.frame !== selected || previous.failed)) blocked("changed publication reconciliation")
        const seal = previous ?? { frame: selected, failed: false }
        if (!previous) {
          sealed.set(tx, seal)
          tx.addMutationGuard(async (keys, tree) => {
            selected.assert()
            const current = mutations.getStore()
            if (current?.open && current.frame === selected) {
              if (keys.every((key) => key[0] === "storage_authority_journal")) return
              if (!tree && current.key && !current.consumed && keys.every((key) => hash(key) === hash(current.key))) {
                current.consumed = true
                return
              }
            }
            if (
              !tree &&
              keys.every(
                (key) =>
                  key[0] === "organization-recovery" &&
                  key[1] === "publication" &&
                  key[2] === selected.target.installationID,
              )
            )
              return
            seal.failed = true
            blocked("writes after publication reconciliation")
          })
        }
        const action = { frame: selected, consumed: false, open: true }
        try {
          await mutations.run(action, () =>
            OrganizationAuthorityHistory.system("recovery.hosted-publish", async (identify, actionID) => {
              identify({
                kind: "system",
                orgID: undefined,
                subjectID: "recovery",
                displayName: "Recovery publication",
                clientKind: "system",
                requestID: actionID,
              })
              for (const { registration } of hosted(evidence)) {
                const expected = Record.RuntimeRegistration.parse({
                  ...registration,
                  deploymentIncarnation: selected.target.incarnation,
                  revision: registration.revision + 1,
                })
                const current = Record.RuntimeRegistration.parse(
                  await Storage.read(Keys.runtime(registration.runtimeID)),
                )
                if (hash(current) === hash(expected)) continue
                if (hash(current) !== hash(registration)) blocked("changed original Hosted registration")
                const permit = {
                  frame: selected,
                  key: Keys.runtime(registration.runtimeID),
                  consumed: false,
                  open: true,
                }
                try {
                  await mutations.run(permit, () => Storage.write(permit.key, expected))
                } finally {
                  permit.open = false
                }
              }
            }),
          )
          for (const { registration } of hosted(evidence)) {
            const expected = Record.RuntimeRegistration.parse({
              ...registration,
              deploymentIncarnation: selected.target.incarnation,
              revision: registration.revision + 1,
            })
            if (hash(await Storage.read(Keys.runtime(registration.runtimeID))) !== hash(expected))
              blocked("incomplete Hosted registration publication")
          }
        } catch (error) {
          seal.failed = true
          throw error
        } finally {
          action.open = false
        }
      },
      { commitGuard: () => assertPublished(evidence, tx) },
    )
  }
  export function assertPublished(evidence: Inspection, tx: StoreTransaction) {
    const selected = frame(evidence)
    const seal = sealed.get(tx)
    if (!seal || seal.frame !== selected || seal.failed)
      blocked("publication reconciliation did not retain its original transaction")
    selected.assert()
  }
  export async function assertServiceOnly() {
    const store = Storage.current().store
    if (store.hasUnpublishedOwners()) blocked("unpublished native owners")
    return Storage.snapshot(async (tx) => {
      for await (const entry of tx.exportEntries()) {
        if (entry.type === "receipt") {
          if (
            !entry.operationID.startsWith("storage-checkpoint:") &&
            !/^runtime-maintenance-begin:[a-f0-9]{64}$/.test(entry.operationID)
          )
            blocked("unclassified operation receipts")
          continue
        }
        if (entry.type === "event") blocked("unreconciled historical events")
        if (entry.type === "artifact") continue
        const [root, kind] = entry.key
        if (root === "organization") {
          const marker = kind && schemaMarkers.get(kind)
          if (
            (marker && entry.key.length === 2 && JSON.stringify(marker) === JSON.stringify(entry.value)) ||
            (kind === "transcript-window-schema" &&
              entry.key.length === 2 &&
              JSON.stringify(entry.value) === JSON.stringify({ schemaVersion: 2 }))
          )
            continue
          if (!kind || !serviceRecords.has(kind)) blocked("organization " + (kind ?? "owner"))
        } else if (!root || !safeRoots.has(root)) blocked("native " + (root ?? "owner"))
      }
      if (store.hasUnpublishedOwners()) blocked("unpublished native owners")
      return { version: 1 as const, externalWriters: 0 as const }
    })
  }
}
