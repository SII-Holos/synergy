import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { readMemberRegistration } from "../../src/registration"
import { openMemberRuntime } from "../../src/runtime"
import { OrganizationCommandHistory as History } from "../../../organization/src/command-history"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import { fixture } from "../support/organization"

type Rows = Map<string, unknown>
function reader(rows: Rows): Record.HistoricalReader {
  return {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing original acknowledged command record")
      return schema.parse(structuredClone(value))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const parsed = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value: structuredClone(value) }
      }
    },
  }
}

test("real Member create and pause history verifies signatures, both indexes and its acknowledged watermark without Hosted authority", async () => {
  await using f = await fixture()
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (
    await f.client.orgProjects.create({ orgProjectCreate: { name: "Original command history" } }, options)
  ).data
  const home = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: f.ca,
    ticket: await f.ticket(home.identity.deviceID, home.publicKey),
  })
  const registration = await readMemberRegistration(home.home, home.identity)
  if (!registration) throw new Error("The actual Member enrollment did not persist")
  const listening = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listening.port
  if (!port) throw new Error("The task-owned Member listener did not allocate a port")
  await listening.stop(true)
  const online = Promise.withResolvers<void>()
  f.interceptFrames((_socket, raw) => {
    if (Runtime.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
    return false
  })
  await using runtime = await openMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: f.ca,
    listen: { port, token: "c".repeat(64) },
  })
  const timeout = setTimeout(() => online.reject(new Error("The original Member bridge did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timeout)
  }
  const created = (
    await f.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "original-member-create",
          creation: { operation: "create" },
        },
      },
      options,
    )
  ).data
  const paused = (
    await f.client.orgCommands.control(
      {
        sessionID: created.effect.sessionID,
        orgCommandControlRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          sessionID: created.effect.sessionID,
          requestID: "original-member-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  expect(paused.effect.operation).toBe("pause")
  const snapshot = await f.service.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const stateKey = Keys.commandState(created.effect.sessionID)
  const state = reader(snapshot).read(Record.CommandState, stateKey)
  expect(state.commandSeq).toBe(paused.permit.commandSeq)
  expect(await History.retainedMember(reader(snapshot), stateKey, state)).toBe(true)
  await expect(History.validate(reader(snapshot), stateKey, state)).rejects.toThrow("Closed command history")
  const createKey = Keys.commandAttempt(created.permit.attemptID)
  const create = reader(snapshot).read(Record.CommandAttempt, createKey)
  const pause = reader(snapshot).read(Record.CommandAttempt, Keys.commandAttempt(paused.permit.attemptID))
  const damaged = new Map(snapshot)
  damaged.set(JSON.stringify(createKey), {
    ...create,
    authorization: { ...create.authorization, signature: pause.authorization.signature },
  })
  await expect(History.retainedMember(reader(damaged), stateKey, state)).rejects.toThrow("acknowledged authority")
  for (const key of [
    Keys.sessionCommand(created.effect.sessionID, created.permit.commandSeq),
    Keys.requestAttempt(created.permit.actor.subjectID, created.permit.requestID, created.permit.commandSeq),
  ]) {
    const missing = new Map(snapshot)
    missing.delete(JSON.stringify(key))
    await expect(History.retainedMember(reader(missing), stateKey, state)).rejects.toThrow()
  }
  const pending = { ...state, pendingAttemptID: paused.permit.attemptID }
  const unresolved = new Map(snapshot)
  unresolved.set(JSON.stringify(stateKey), pending)
  await expect(History.retainedMember(reader(unresolved), stateKey, pending)).rejects.toThrow("pending command")
  const behind = { ...state, commandSeq: created.permit.commandSeq }
  const incomplete = new Map(snapshot)
  incomplete.set(JSON.stringify(stateKey), behind)
  await expect(History.retainedMember(reader(incomplete), stateKey, behind)).rejects.toThrow()
  expect(await History.retainedMember(reader(snapshot), stateKey, state)).toBe(true)
  f.interceptFrames(undefined)
})
