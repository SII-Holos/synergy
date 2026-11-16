import { expect } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import {
  OrganizationRecoveryPublication,
  OrganizationServiceNative,
} from "@ericsanchezok/synergy-organization/backup/recovery"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import type { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { OrganizationRecoveryPublicationRecords as Publications } from "../../../organization/src/backup/publication-records"
import { OrganizationExecutionLeases as Leases } from "../../src/execution-leases"
import type { completedHostedTask } from "./hosted-task"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import { OrganizationRuntimeHistory } from "../../../organization/src/runtime-history"

type Runtime = { run<T>(body: () => Promise<T>): Promise<T> }
type Service = Awaited<ReturnType<typeof openOrganizationService>>
type Task = Awaited<ReturnType<typeof completedHostedTask>>

export async function captureHostedRepeatHistory(input: {
  service: Service
  runtime: Runtime
  task: Task
  installationID: string
  hostedInstallationID: string
  runtimeID: string
}) {
  const { task } = input
  const modelCalls = task.calls.length
  const publication = await input.service.maintenance.run(async () => {
    const receipt = await OrganizationRecoveryPublication.read(input.installationID)
    expect(receipt.version).toBe(3)
    const hosted = Publications.validateHosted(
      await Storage.read(Publications.hostedKey(input.installationID, input.runtimeID)),
      receipt,
      input.runtimeID,
    )
    expect(hosted.version).toBe(2)
    const items = await Publications.readQueued(input.installationID, input.runtimeID, hosted)
    expect(items).toHaveLength(1)
    const rows = []
    for await (const row of Storage.records({ prefix: Publications.key(input.installationID), limit: 128 }))
      rows.push({ key: row.key, value: row.value, text: JSON.stringify(row.value) })
    return { receipt, hosted, items, rows }
  })
  const enrollment = await input.service.maintenance.run(() =>
    Storage.snapshot(async () => {
      const runtimeKey = Keys.runtime(input.runtimeID)
      const signingKey = Keys.signingIdentity()
      const rows = new Map<string, unknown>(publication.rows.map((row) => [JSON.stringify(row.key), row.value]))
      const tickets = []
      for await (const row of Storage.records({ prefix: ["organization", "runtime-tickets"], limit: 128 })) {
        const ticket = Record.RuntimeTicket.parse(row.value)
        if (ticket.runtimeID === input.runtimeID) {
          tickets.push({ key: row.key, value: ticket, raw: row.value, text: JSON.stringify(row.value) })
          rows.set(JSON.stringify(row.key), row.value)
        }
      }
      expect(tickets).toHaveLength(1)
      for (const key of [runtimeKey, signingKey]) rows.set(JSON.stringify(key), await Storage.read(key))
      const reader: Record.HistoricalReader = {
        read(schema, key) {
          return schema.parse(rows.get(JSON.stringify(key)))
        },
        *entries(prefix) {
          for (const [encoded, value] of rows) {
            const key: string[] = JSON.parse(encoded)
            if (prefix.every((part, index) => key[index] === part)) yield { key, value }
          }
        },
      }
      const ticket = tickets[0]!
      const current = reader.read(Record.RuntimeRegistration, runtimeKey)
      if (current.runtimeKind !== "hosted" || ticket.value.consumed?.runtimeKind !== "hosted")
        throw new Error("The real repeated recovery lacks its actual original Hosted enrollment")
      expect(ticket.value.consumed.deploymentIncarnation).not.toBe(current.deploymentIncarnation)
      const { schemaVersion, ...original } = OrganizationRuntimeHistory.enrollment(reader, ticket.value)
      expect(schemaVersion).toBe(1)
      expect(original).toEqual(publication.hosted.original)
      expect(current).toMatchObject({
        runtimeID: publication.hosted.published.runtimeID,
        orgID: publication.hosted.published.orgID,
        deploymentIncarnation: publication.hosted.published.deploymentIncarnation,
        publicKey: publication.hosted.published.publicKey,
      })
      function change(key: string[], value: unknown, candidate = ticket.value) {
        const address = JSON.stringify(key),
          previous = rows.get(address)
        if (previous === undefined) throw new Error("Missing original recovered enrollment control")
        if (value === undefined) rows.delete(address)
        else rows.set(address, value)
        try {
          expect(() => OrganizationRuntimeHistory.enrollment(reader, candidate)).toThrow()
        } finally {
          rows.set(address, previous)
        }
      }
      change(Publications.key(input.installationID), undefined)
      change(Publications.hostedKey(input.installationID, input.runtimeID), undefined)
      const { sourceIdentity: _, ...legacy } = publication.receipt
      change(Publications.key(input.installationID), Publications.Receipt.parse({ ...legacy, version: 2 }))
      const foreignKey = publication.receipt.identity.publicKey
      expect(foreignKey).not.toBe(publication.hosted.original.publicKey)
      change(
        Publications.hostedKey(input.installationID, input.runtimeID),
        Publications.Hosted.parse({
          ...publication.hosted,
          original: { ...publication.hosted.original, publicKey: foreignKey },
          published: { ...publication.hosted.published, publicKey: foreignKey },
        }),
      )
      change(runtimeKey, Record.RuntimeRegistration.parse({ ...current, name: current.name + " changed" }))
      for (const patch of [
        { consumed: undefined },
        { accountID: crypto.randomUUID() },
        { consumed: { ...ticket.value.consumed, name: ticket.value.consumed.name + " changed" } },
        { consumed: { ...ticket.value.consumed, deploymentIncarnation: crypto.randomUUID() } },
        { consumed: { ...ticket.value.consumed, createdAt: ticket.value.consumed.createdAt + 1 } },
        { registrationRevision: ticket.value.registrationRevision + 1 },
        { consumed: { ...ticket.value.consumed, connectionEpoch: original.connectionEpoch + 1 } },
      ]) {
        const altered = Record.RuntimeTicket.parse({ ...ticket.value, ...patch })
        change(ticket.key, altered, altered)
      }
      expect(OrganizationRuntimeHistory.enrollment(reader, ticket.value)).toEqual({ schemaVersion, ...original })
      expect(await Storage.read(ticket.key)).toEqual(ticket.raw)
      return tickets
    }),
  )
  const roots = [task.nativeRelease.rootID, ...publication.items.map((item) => item.rootID)]
  expect(new Set(roots).size).toBe(2)
  const nativePublicationKey = ["organization-runtime-recovery", "publication", input.hostedInstallationID]
  const readNative = (runtime: Runtime) =>
    runtime.run(async () => {
      const session = await Session.get(task.sessionID)
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
      const messages = []
      for await (const message of MessageV2.stream({ scopeID: session.scope.id, sessionID: session.id }))
        messages.push(message)
      const runs = []
      for (const rootID of roots) {
        const run = await RolloutLedger.getRun(owner, rootID)
        expect(run).toMatchObject({ status: "completed", recording: "complete" })
        const calls = await RolloutLedger.calls(owner, rootID)
        expect(calls.every((call) => call.status === "completed")).toBe(true)
        runs.push({
          run,
          calls,
          segments: await RolloutLedger.segments(owner, rootID),
          tools: await RolloutLedger.tools(owner, rootID),
        })
      }
      expect(await SessionManager.isRunning(task.sessionID)).toBe(false)
      expect(await Leases.pendingForCapture()).toBe(false)
      const entries = await Leases.captureEntries()
      expect(entries.every((entry) => entry.state === "settled")).toBe(true)
      const nativePublication = await Storage.read(nativePublicationKey)
      expect(nativePublication).toMatchObject({ version: 1 })
      return {
        session: { id: session.id, scope: session.scope, organization: session.organization },
        messages,
        runs,
        entries,
        nativePublication,
        proof: Buffer.from(await Storage.readBinary(["recovery", "proof"])),
      }
    })
  const native = await readNative(input.runtime)
  expect(task.calls).toHaveLength(modelCalls)
  return {
    modelCalls,
    async verify(current: {
      service: Service
      runtime: Runtime
      installationID: string
      sourceNamespace: { directory: string; expected: StorageCheckpoint.Manifest }
      keys: VaultKeyProvider
    }) {
      expect(current.installationID).not.toBe(input.installationID)
      const registrationKey = JSON.stringify(Keys.runtime(input.runtimeID))
      let registration: Record.RuntimeRegistration | undefined
      for await (const entry of StorageCheckpoint.entries({ ...current.sourceNamespace, keys: current.keys })) {
        if (entry.type !== "record" || JSON.stringify(entry.key) !== registrationKey) continue
        if (registration) throw new Error("The actual fixed H1 checkpoint repeats its Hosted registration")
        registration = Record.RuntimeRegistration.parse(entry.value)
      }
      if (!registration || registration.runtimeKind !== "hosted")
        throw new Error("The actual fixed H1 checkpoint lacks its original Hosted registration")
      const { schemaVersion, ...original } = registration
      expect(schemaVersion).toBe(1)
      expect(original.runtimeID).toBe(input.runtimeID)
      expect(original.orgID).toBe(publication.receipt.identity.orgID)
      expect(original.deploymentIncarnation).toBe(publication.receipt.identity.deploymentIncarnation)
      const namespaceHash = OrganizationServiceNative.sourceHash(current.sourceNamespace.expected)
      await current.service.maintenance.run(async () => {
        const retained = await Storage.readMany(publication.rows.map((row) => row.key))
        expect(retained).toEqual(publication.rows.map((row) => row.value))
        expect(retained.map((value) => JSON.stringify(value))).toEqual(publication.rows.map((row) => row.text))
        expect(await OrganizationRecoveryPublication.read(input.installationID)).toEqual(publication.receipt)
        expect(await Publications.readQueued(input.installationID, input.runtimeID, publication.hosted)).toEqual(
          publication.items,
        )
        const enrolled = await Storage.readMany(enrollment.map((ticket) => ticket.key))
        expect(enrolled).toEqual(enrollment.map((ticket) => ticket.raw))
        expect(enrolled.map((ticket) => JSON.stringify(ticket))).toEqual(enrollment.map((ticket) => ticket.text))
        const receipt = await OrganizationRecoveryPublication.read(current.installationID)
        expect(receipt.version).toBe(3)
        if (receipt.version !== 3) throw new Error("Repeated recovery lacks its actual historical signing identity")
        expect(receipt.sourceIdentity).toEqual(publication.receipt.identity)
        expect(receipt.identity.publicKey).not.toBe(publication.receipt.identity.publicKey)
        expect(receipt.identity.keyID).not.toBe(publication.receipt.identity.keyID)
        expect(receipt.identity.deploymentIncarnation).not.toBe(publication.receipt.identity.deploymentIncarnation)
        const hosted = Publications.validateHosted(
          await Storage.read(Publications.hostedKey(current.installationID, input.runtimeID)),
          receipt,
          input.runtimeID,
        )
        expect(receipt.source.current.namespaceHash).toBe(namespaceHash)
        expect(hosted.namespaceHash).toBe(namespaceHash)
        expect(hosted.version).toBe(1)
        expect(hosted.original).toEqual(original)
        expect(await Publications.readQueued(current.installationID, input.runtimeID, hosted)).toEqual([])
      })
      expect(await readNative(current.runtime)).toEqual(native)
      expect(task.calls).toHaveLength(modelCalls)
    },
  }
}
