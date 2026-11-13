import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffProtocol as Handoff } from "../../organization-protocol/src/handoff"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationAuthorityHistory } from "../src/authority-history"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationProjects } from "../src/projects"
import { OrganizationSessionDirectory } from "../src/session-directory"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { commandFixture } from "./support/commands"
import { connection, keys } from "./support/runtime"
import { handoffMachineRoutes } from "../src/routes/handoff"
import { organizationApp } from "../src/http"
import { createRuntimeRegistrations } from "../src/runtime-registration"

async function fixture(targetAccountID = "bob", handoffVersion = 1) {
  const f = await commandFixture()
  await f.connect(1, true, false, false, true, handoffVersion)
  const targetKeys = await keys()
  const target = await f.run(async () => {
    const value = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
    const updated = Record.RuntimeRegistration.parse({
      ...value,
      accountID: targetAccountID,
      connectionEpoch: 0,
      publicKey: targetKeys.publicKey,
    })
    await Storage.write(Keys.runtime("runtime-bob"), updated)
    return updated
  })
  const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = reject
  })
  const signed = await connection(target, targetKeys.privateKey, 1)
  signed.proof.handshake.capabilities.push("commands", "handoffs")
  signed.proof.handshake.schemas.commands = 1
  signed.proof.handshake.schemas.handoffs = handoffVersion
  signed.signature = await Runtime.sign(signed.proof, targetKeys.privateKey)
  const connected = Promise.withResolvers<unknown>()
  socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
  socket.send(JSON.stringify(signed))
  Runtime.Connected.parse(await connected.promise)
  await f.run(async () => {
    OrganizationAuthorityHistory.register()
    registerHandoffAuthorityHistory()
    await OrganizationAuthorityHistory.initialize({
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
  })
  const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
  return {
    ...f,
    targetKeys,
    targetSocket: socket,
    handoffs,
    async [Symbol.asyncDispose]() {
      socket.close()
      await f[Symbol.asyncDispose]()
    },
  }
}

async function nativeInspectionFixture(handoffID: string) {
  const f = await fixture("bob", 5)
  try {
    const native = Handoff.NativeTarget.parse({
      reference: { workspaceID: "original-native", generation: 2, revision: 3 },
      projectRevision: "a".repeat(64),
      label: "Bob original folder",
    })
    const prepared = await f.run(async () => {
      await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
      const current = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      return f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID,
        targetRuntimeID: "runtime-bob",
        expectedBindingEpoch: current.bindingEpoch,
        expectedControlRevision: current.controlRevision,
        mappingPlanRevision: 1,
        workspaceMapping: {
          kind: "organization-native",
          moveID: `${handoffID}-move`,
          source: { workspaceID: "original-cloud", generation: 1 },
          resource: { resourceID: "original-storage", workspaceID: "original-cloud", generation: 1, path: "shared" },
          target: {
            kind: "existing",
            workspaceID: native.reference.workspaceID,
            generation: native.reference.generation,
            expectedRevision: native.reference.revision,
            projectRevision: native.projectRevision,
          },
        },
      })
    })
    return { ...f, native, prepared }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

function holdNativeInspection(f: Awaited<ReturnType<typeof nativeInspectionFixture>>) {
  const held = Promise.withResolvers<{
    authorization: Handoff.SignedInspectionPlan
    reply(native?: Handoff.NativeTarget): void
  }>()
  f.targetSocket.onmessage = async (event) => {
    try {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      if (frame.type !== "command" || frame.command.kind !== "handoff-inspection") return
      const authorization = frame.command.authorization
      expect(
        await Handoff.verifyInspection(authorization.plan, authorization.signature, f.signing.identity.publicKey),
      ).toBe(true)
      held.resolve({
        authorization,
        reply(native = f.native) {
          const result = Handoff.InspectionResult.strip().parse({ ...authorization.plan, workspace: null, native })
          f.targetSocket.send(
            JSON.stringify({
              type: "receipt",
              connectionEpoch: frame.connectionEpoch,
              exchangeID: frame.exchangeID,
              reply: { kind: "handoff-inspection", authorization, result },
            }),
          )
        },
      })
    } catch (error) {
      held.reject(error)
    }
  }
  return held.promise
}

test("reader five rejects a private native download before source freeze or handoff admission", async () => {
  await using f = await fixture("bob", 5)
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const previous = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await expect(
      f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "unsupported-private-download",
        targetRuntimeID: "runtime-bob",
        expectedBindingEpoch: previous.bindingEpoch,
        expectedControlRevision: previous.controlRevision,
        mappingPlanRevision: 1,
        workspaceMapping: {
          kind: "organization-native",
          moveID: "unsupported-private-download-move",
          source: { workspaceID: "original-cloud", generation: 1 },
          resource: { resourceID: "original-storage", workspaceID: "original-cloud", generation: 1, path: "shared" },
          target: { kind: "private-copy" },
        },
      }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(previous)
    await expect(f.handoffs.get(f.credentials.alice, "unsupported-private-download")).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
  })
})

test.each(["organization-live", "organization-native"] as const)(
  "reader six rejects a whole-root %s mapping before source freeze or handoff admission",
  async (kind) => {
    await using f = await fixture("bob", 6)
    await f.run(async () => {
      await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
      const previous = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      const source = { workspaceID: "original-cloud", generation: 1 }
      const resource = { resourceID: "original-storage", workspaceID: "original-cloud", generation: 1, path: "" }
      const workspaceMapping =
        kind === "organization-live"
          ? { kind, source, resource }
          : { kind, source, resource, moveID: "whole-download", target: { kind: "private-copy" as const } }
      await expect(
        f.handoffs.prepare(f.credentials.alice, f.sessionID, {
          handoffID: "unsupported-whole-root-" + kind,
          targetRuntimeID: "runtime-bob",
          expectedBindingEpoch: previous.bindingEpoch,
          expectedControlRevision: previous.controlRevision,
          mappingPlanRevision: 1,
          workspaceMapping,
        }),
      ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
      expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(previous)
      await expect(f.handoffs.get(f.credentials.alice, "unsupported-whole-root-" + kind)).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
    })
  },
)

test("native directory inspection retains the accepted caller credentials after the caller object changes", async () => {
  await using f = await nativeInspectionFixture("native-caller-snapshot")
  const received = holdNativeInspection(f)
  const credentials = { ...f.credentials.bob }
  const pending = Promise.resolve(
    f.run(() =>
      f.handoffs.nativeTarget(
        credentials,
        f.prepared.handoffID,
        { requestID: "original-bob-inspection" },
        { signal: new AbortController().signal },
      ),
    ),
  ).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const held = await Promise.race([
    received,
    pending.then(() => {
      throw new Error("Inspection settled before the original target reply")
    }),
  ])
  expect(held.authorization.plan.actor.subjectID).toBe("bob")
  credentials.token = f.credentials.alice.token
  held.reply()
  expect(await pending).toMatchObject({ ok: true, value: { requestID: "original-bob-inspection", native: f.native } })
})

test("native directory labels require the original destination member and complete native reference", async () => {
  await using f = await nativeInspectionFixture("native-reference-guards")
  for (const credentials of [f.credentials.alice, f.credentials.admin]) {
    const unexpected = holdNativeInspection(f)
    void unexpected.then((held) => held.reply()).catch(() => {})
    await expect(
      f.run(() =>
        f.handoffs.nativeTarget(
          credentials,
          f.prepared.handoffID,
          { requestID: "wrong-native-reader" },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  }
  for (const changed of [
    { ...f.native, reference: { ...f.native.reference, workspaceID: "other-native" } },
    { ...f.native, reference: { ...f.native.reference, generation: f.native.reference.generation + 1 } },
    { ...f.native, reference: { ...f.native.reference, revision: f.native.reference.revision + 1 } },
    { ...f.native, projectRevision: "b".repeat(64) },
  ]) {
    const received = holdNativeInspection(f)
    const pending = Promise.resolve(
      f.run(() =>
        f.handoffs.nativeTarget(
          f.credentials.bob,
          f.prepared.handoffID,
          { requestID: "changed-native-reference" },
          { signal: new AbortController().signal },
        ),
      ),
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    const held = await Promise.race([
      received,
      pending.then(() => {
        throw new Error("Inspection settled before its native reply")
      }),
    ])
    held.reply(changed)
    expect(await pending).toMatchObject({ ok: false, error: { data: { code: "REVISION_CONFLICT" } } })
  }
  expect(await f.run(() => f.handoffs.get(f.credentials.bob, f.prepared.handoffID))).toMatchObject({
    phase: "preparing",
    targetAccepted: false,
    mappingPlanRevision: f.prepared.mappingPlanRevision,
  })
})

for (const change of ["role-loss", "cancel", "reconnect"] as const)
  test(`a held native directory reply cannot disclose its label after ${change}`, async () => {
    await using f = await nativeInspectionFixture(`held-native-${change}`)
    const received = holdNativeInspection(f)
    const pending = Promise.resolve(
      f.run(() =>
        f.handoffs.nativeTarget(
          f.credentials.bob,
          f.prepared.handoffID,
          { requestID: `held-native-${change}` },
          { signal: new AbortController().signal },
        ),
      ),
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    const held = await Promise.race([
      received,
      pending.then(() => {
        throw new Error("Inspection settled before its native reply")
      }),
    ])
    let replacement: WebSocket | undefined
    try {
      if (change === "role-loss") {
        await f.run(() =>
          OrganizationProjects.member(f.credentials.admin, "project", "bob", { expectedRevision: 1, role: null }),
        )
      } else if (change === "cancel") {
        await f.run(() => f.handoffs.cancel(f.credentials.alice, f.prepared.handoffID))
      } else {
        const target = await f.run(() => Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))
        if (!target) throw new Error("Original target registration is missing")
        replacement = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
        const socket = replacement
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve()
          socket.onerror = reject
        })
        const signed = await connection(target, f.targetKeys.privateKey, 2)
        signed.proof.handshake.capabilities.push("commands", "handoffs")
        signed.proof.handshake.schemas.commands = 1
        signed.proof.handshake.schemas.handoffs = 5
        signed.signature = await Runtime.sign(signed.proof, f.targetKeys.privateKey)
        const connected = Promise.withResolvers<unknown>()
        socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
        socket.send(JSON.stringify(signed))
        expect(Runtime.Connected.parse(await connected.promise).connectionEpoch).toBe(2)
      }
      held.reply()
      const result = await pending
      expect(result).toMatchObject({ ok: false })
      expect(JSON.stringify(result)).not.toContain(f.native.label)
    } finally {
      replacement?.close()
      await pending
    }
  })

test("destination discovery bounds empty pages and rejects cursors from another authorized scope", async () => {
  await using f = await fixture("bob", 5)
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const before = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    const first = await f.handoffs.targets(
      f.credentials.alice,
      f.sessionID,
      { limit: 1 },
      { signal: new AbortController().signal },
    )
    expect(first.items).toEqual([])
    expect(first.cursor).toBeString()
    const cursor = first.cursor!
    const second = await f.handoffs.targets(
      f.credentials.alice,
      f.sessionID,
      { limit: 1, cursor },
      { signal: new AbortController().signal },
    )
    expect(second.items).toEqual([])
    expect(second.cursor).toBeUndefined()
    await OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
      sessionID: "ses_other_discovery",
      projectID: "project",
      runtimeID: "runtime-alice",
    })
    await expect(
      f.handoffs.targets(
        f.credentials.alice,
        "ses_other_discovery",
        { limit: 1, cursor },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ data: { code: "STALE_BINDING" } })
    await expect(
      f.handoffs.targets(
        f.credentials.bob,
        f.sessionID,
        { limit: 1, cursor },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    const original = z.record(z.string(), z.unknown()).parse(decoded)
    for (const changed of [
      { ...original, accountID: "bob" },
      { ...original, bindingEpoch: first.bindingEpoch + 1 },
    ]) {
      const stale = Buffer.from(JSON.stringify(changed)).toString("base64url")
      await expect(
        f.handoffs.targets(
          f.credentials.alice,
          f.sessionID,
          { limit: 1, cursor: stale },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ data: { code: "STALE_BINDING" } })
    }
    await expect(
      f.handoffs.targets(
        f.credentials.alice,
        f.sessionID,
        { limit: 1, cursor: "not-json" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(before)
    expect(await Storage.list(["organization", "handoffs"])).toEqual([])
    await OrganizationSharing.unshare(f.credentials.alice, f.sessionID, { expectedShareGeneration: 1 })
    await expect(
      f.handoffs.targets(
        f.credentials.alice,
        f.sessionID,
        { limit: 1, cursor },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ data: { code: "STALE_BINDING" } })
  })
})

test("destination discovery keeps its original cancellation signal before the first read", async () => {
  await using f = await fixture()
  const original = new AbortController(),
    input = { signal: original.signal }
  const pending = Promise.resolve(
    f.run(() => f.handoffs.targets(f.credentials.alice, f.sessionID, { limit: 1 }, input)),
  )
  input.signal = new AbortController().signal
  original.abort(new Error("Original destination discovery cancelled"))
  await expect(pending).rejects.toThrow("Original destination discovery cancelled")
})

test("handoff destinations page only the current Session's eligible project participants", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    for (const id of ["alice", "bob", "reader", "foreign"])
      await Storage.write(Keys.accountRuntime(id, `runtime-${id}`), { runtimeID: `runtime-${id}` })
    const original = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-alice")))!
    await Storage.write(Keys.runtime("runtime-alice-2"), {
      ...original,
      runtimeID: "runtime-alice-2",
      deviceID: "device-alice-2",
      connectionEpoch: 0,
    })
    await Storage.write(Keys.accountRuntime("alice", "runtime-alice-2"), { runtimeID: "runtime-alice-2" })
  })
  const app = organizationApp(
    () => true,
    undefined,
    "https://organization.example",
    createRuntimeRegistrations(),
    f.connections,
    undefined,
    f.forwarder,
    f.execution,
    f.gateway,
    f.handoffs,
  )
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => f.run(() => app.fetch(request)) })
  await using http = { [Symbol.asyncDispose]: () => server.stop(true) }
  const baseUrl = server.url.toString()
  const ordinary = await fetch(new URL("/org/v1/runtimes?limit=100", baseUrl), {
    headers: f.apiHeaders("alice"),
  })
  expect(ordinary.status).toBe(200)
  const registrations = Runtime.RegistrationPage.parse(await ordinary.json())
  expect(registrations.items.some((item) => item.runtimeID === "runtime-bob")).toBe(false)
  let cursor: string | undefined
  const found: string[] = []
  const availability = new Map<string, Handoff.Target["availability"]>()
  for (let page = 0; page < 20; page++) {
    const url = new URL(`/org/v1/sessions/${f.sessionID}/handoff-targets`, baseUrl)
    url.searchParams.set("limit", "1")
    if (cursor) url.searchParams.set("cursor", cursor)
    const response = await fetch(url, { headers: f.apiHeaders("alice") })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(f.targetKeys.publicKey)
    const result = Handoff.TargetPage.parse(JSON.parse(body))
    expect(result).toMatchObject({ sessionID: f.sessionID, sourceRuntimeID: "runtime-alice", bindingEpoch: 1 })
    expect(result.items.length).toBeLessThanOrEqual(1)
    for (const item of result.items) {
      expect(found).not.toContain(item.runtimeID)
      found.push(item.runtimeID)
      availability.set(item.runtimeID, item.availability)
    }
    cursor = result.cursor
    if (!cursor) break
    if (page === 19) throw new Error("Handoff target paging did not terminate")
  }
  expect(found.sort()).toEqual(["runtime-alice-2", "runtime-bob"])
  expect(Object.fromEntries(availability)).toEqual({ "runtime-alice-2": "offline", "runtime-bob": "incompatible" })
  for (const id of ["bob", "reader", "admin", "foreign"]) {
    const denied = await fetch(new URL(`/org/v1/sessions/${f.sessionID}/handoff-targets`, baseUrl), {
      headers: f.apiHeaders(id),
    })
    expect(denied.status).toBe(id === "foreign" ? 401 : 403)
  }
  await f.run(() => OrganizationSharing.unshare(f.credentials.alice, f.sessionID, { expectedShareGeneration: 1 }))
  const privateTargets = await fetch(new URL(`/org/v1/sessions/${f.sessionID}/handoff-targets?limit=100`, baseUrl), {
    headers: f.apiHeaders("alice"),
  })
  expect(privateTargets.status).toBe(200)
  expect(
    Handoff.TargetPage.parse(await privateTargets.json()).items.every((item) => item.runtimeID !== "runtime-bob"),
  ).toBe(true)
})

test("ready destination discovery does not provision a Runtime or reserve a handoff epoch", async () => {
  await using f = await fixture("bob", 5)
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    await Storage.write(Keys.accountRuntime("bob", "runtime-bob"), { runtimeID: "runtime-bob" })
    const original = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    const runtimes = await Storage.list(Keys.runtimes())
    const page = await f.handoffs.targets(
      f.credentials.alice,
      f.sessionID,
      { limit: 100 },
      { signal: new AbortController().signal },
    )
    expect(page.items).toMatchObject([
      { runtimeID: "runtime-bob", runtimeKind: "member", state: "active", availability: "ready" },
    ])
    expect(page.cursor).toBeUndefined()
    expect(await Storage.list(Keys.runtimes())).toEqual(runtimes)
    expect(await Storage.list(["organization", "handoffs"])).toEqual([])
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(original)
  })
})

test("the destination member reads only its original native directory before accepting a handoff", async () => {
  await using f = await nativeInspectionFixture("inspect-original-directory")
  const { native, prepared } = f
  expect(prepared).toMatchObject({ phase: "preparing", canAccept: false, targetAccepted: false })
  const observed = Promise.withResolvers<Handoff.SignedInspectionPlan>()
  f.targetSocket.onmessage = async (event) => {
    try {
      const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
      if (frame.type !== "command" || frame.command.kind !== "handoff-inspection") return
      const authorization = frame.command.authorization
      expect(
        await Handoff.verifyInspection(authorization.plan, authorization.signature, f.signing.identity.publicKey),
      ).toBe(true)
      const result = Handoff.InspectionResult.strip().parse({ ...authorization.plan, workspace: null, native })
      f.targetSocket.send(
        JSON.stringify({
          type: "receipt",
          connectionEpoch: frame.connectionEpoch,
          exchangeID: frame.exchangeID,
          reply: { kind: "handoff-inspection", authorization, result },
        }),
      )
      observed.resolve(authorization)
    } catch (error) {
      observed.reject(error)
    }
  }
  const app = organizationApp(
    () => true,
    undefined,
    "https://organization.example",
    createRuntimeRegistrations(),
    f.connections,
    undefined,
    f.forwarder,
    f.execution,
    f.gateway,
    f.handoffs,
  )
  const response = await f.run(() =>
    app.fetch(
      new Request(
        `https://organization.example/org/v1/handoffs/${prepared.handoffID}/native-target?requestID=original-label`,
        { headers: f.apiHeaders("bob") },
      ),
    ),
  )
  expect(response.status).toBe(200)
  expect(Handoff.NativeTargetSelection.parse(await response.json())).toEqual({
    requestID: "original-label",
    handoffID: prepared.handoffID,
    targetRuntimeID: "runtime-bob",
    mappingPlanRevision: prepared.mappingPlanRevision,
    mappingHash: prepared.mappingHash,
    native,
  })
  expect((await observed.promise).plan.actor.subjectID).toBe("bob")
  const current = await f.run(() => f.handoffs.get(f.credentials.bob, prepared.handoffID))
  expect(current).toMatchObject({ phase: "preparing", targetAccepted: false })
})

test("target cleanup discovery shares the original Handoff transaction and validates bounded participant index pages", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const before = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    const prefix = [
      "organization",
      "handoff-targets",
      "runtime-bob",
      createHash("sha256").update(f.targetKeys.publicKey).digest("hex"),
    ]
    const handoffID = "rollback-cleanup-slot"
    const input = {
      handoffID,
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: before.bindingEpoch,
      expectedControlRevision: before.controlRevision,
      mappingPlanRevision: 1,
    }
    await expect(
      Storage.transaction(async () => {
        await f.handoffs.prepare(f.credentials.alice, f.sessionID, input)
        expect(await Storage.read([...prefix, handoffID])).toEqual({ version: 1, handoffID })
        throw new Error("Roll back original Handoff publication")
      }),
    ).rejects.toThrow("Roll back original Handoff publication")
    expect(
      await Storage.readMany([
        ["organization", "handoffs", handoffID],
        [...prefix, handoffID],
      ]),
    ).toEqual([undefined, undefined])
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(before)
    for (const id of [handoffID, "filtered-cleanup-2", "filtered-cleanup-3"]) {
      const current = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      const prepared = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        ...input,
        handoffID: id,
        expectedControlRevision: current.controlRevision,
      })
      await f.handoffs.cancel(f.credentials.alice, id)
      const proof = Handoff.Proof.parse({
        ...Handoff.Binding.strip().parse(prepared),
        purpose: "source-cancelled",
        manifestHash: null,
        gateCancelled: true,
        paused: true,
      })
      await f.handoffs.proof({ proof, signature: await Handoff.signProof(proof, f.machineKeys.privateKey) })
    }
    let cursor: string | undefined,
      pages = 0
    do {
      const page = await f.handoffs.cleanupCandidates(f.credentials.bob, "runtime-bob", { limit: 1, cursor })
      expect(page.items).toEqual([])
      cursor = page.cursor
      pages++
      expect(pages).toBeLessThanOrEqual(4)
    } while (cursor)
    expect(pages).toBeGreaterThanOrEqual(3)
    const key = [...prefix, handoffID],
      original = await Storage.read(key)
    try {
      for (const changed of [
        { version: 99, handoffID },
        { version: 1, handoffID, unknown: true },
        { version: 1, handoffID: "other" },
      ]) {
        await Storage.write(key, changed)
        await expect(f.handoffs.cleanupCandidates(f.credentials.bob, "runtime-bob", { limit: 100 })).rejects.toThrow()
      }
    } finally {
      await Storage.write(key, original)
    }
    await expect(f.handoffs.cleanupCandidates(f.credentials.alice, "runtime-bob", { limit: 100 })).rejects.toThrow(
      "Runtime not found",
    )
    const primary = ["organization", "handoffs", handoffID],
      record = await Storage.read<Record<string, unknown>>(primary)
    const target = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-alice")))!
    try {
      await Storage.write(primary, {
        ...record,
        target: { ...Runtime.Registration.parse(record.target), publicKey: target.publicKey },
      })
      await expect(f.handoffs.cleanupCandidates(f.credentials.bob, "runtime-bob", { limit: 100 })).rejects.toThrow()
    } finally {
      await Storage.write(primary, record)
    }
  })
})

test("replaying an old target proof after cancellation and unsharing cannot observe a later private binding", async () => {
  await using f = await fixture()
  let privateSocket: WebSocket | undefined
  try {
    await f.run(async () => {
      await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
      const original = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "old-observer",
        targetRuntimeID: "runtime-bob",
        expectedBindingEpoch: 1,
        expectedControlRevision: 0,
        mappingPlanRevision: 1,
      })
      await f.handoffs.accept(f.credentials.bob, original.handoffID, { mappingPlanRevision: 1 })
      const tuple = (view: Handoff.View) => Handoff.Binding.strip().parse(view)
      const frozen = (view: Handoff.View, manifestHash: string) =>
        Handoff.Proof.parse({
          ...tuple(view),
          purpose: "source-frozen",
          manifestHash,
          commandSeq: view.commandSeq,
          receivedSeq: view.commandSeq,
          compatibilityHash: "b".repeat(64),
          closureHash: "c".repeat(64),
          fileClosureHash: null,
          workspaceMoveReceiptHash: null,
          paused: true,
          drained: true,
        })
      const prepared = (view: Handoff.View, manifestHash: string) =>
        Handoff.Proof.parse({
          ...tuple(view),
          purpose: "target-prepared",
          manifestHash,
          compatibilityHash: "b".repeat(64),
          convertedHash: "d".repeat(64),
          closureHash: "c".repeat(64),
          fileClosureHash: null,
          workspaceMoveReceiptHash: null,
          paused: true,
        })
      const publish = async (proof: Handoff.Proof, key: CryptoKey) =>
        f.handoffs.proof({ proof, signature: await Handoff.signProof(proof, key) })
      await publish(frozen(original, "a".repeat(64)), f.machineKeys.privateKey)
      const oldFact = prepared(original, "a".repeat(64)),
        oldSigned = { proof: oldFact, signature: await Handoff.signProof(oldFact, f.targetKeys.privateKey) }
      await f.handoffs.proof(oldSigned)
      await f.handoffs.cancel(f.credentials.alice, original.handoffID)
      await publish(
        Handoff.Proof.parse({
          ...tuple(original),
          purpose: "source-cancelled",
          manifestHash: "a".repeat(64),
          gateCancelled: true,
          paused: true,
        }),
        f.machineKeys.privateKey,
      )
      await OrganizationSharing.unshare(f.credentials.alice, f.sessionID, { expectedShareGeneration: 1 })
      await expect(f.handoffs.get(f.credentials.bob, original.handoffID)).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
      const privateKeys = await keys()
      const privateRuntime = await OrganizationAuthorityHistory.credentials(
        f.credentials.alice,
        "runtime.register",
        async () => {
          const source = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-alice")))!
          const runtime = Record.RuntimeRegistration.parse({
            ...source,
            runtimeID: "runtime-private-alice",
            deviceID: "private-device",
            connectionEpoch: 0,
            publicKey: privateKeys.publicKey,
          })
          await Storage.write(Keys.runtime(runtime.runtimeID), runtime)
          return runtime
        },
      )
      privateSocket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
      const socket = privateSocket
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = reject
      })
      const signed = await connection(privateRuntime, privateKeys.privateKey, 1)
      signed.proof.handshake.capabilities.push("commands", "handoffs")
      signed.proof.handshake.schemas.commands = 1
      signed.proof.handshake.schemas.handoffs = 1
      signed.signature = await Runtime.sign(signed.proof, privateKeys.privateKey)
      const connected = Promise.withResolvers<unknown>()
      socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
      socket.send(JSON.stringify(signed))
      Runtime.Connected.parse(await connected.promise)
      const current = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
      const next = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "private-next",
        targetRuntimeID: privateRuntime.runtimeID,
        expectedBindingEpoch: current.bindingEpoch,
        expectedControlRevision: current.controlRevision,
        mappingPlanRevision: 1,
      })
      await f.handoffs.accept(f.credentials.alice, next.handoffID, { mappingPlanRevision: 1 })
      await publish(frozen(next, "e".repeat(64)), f.machineKeys.privateKey)
      const target = prepared(next, "e".repeat(64))
      await publish(target, privateKeys.privateKey)
      const permit = await f.handoffs.permit(f.credentials.alice, next.handoffID, { purpose: "handoff-surrender" })
      await publish(
        Handoff.Proof.parse({
          ...tuple(next),
          purpose: "source-surrendered",
          manifestHash: "e".repeat(64),
          preparedHash: await Handoff.proofHash(target),
          permitID: permit.permit.permitID,
          gatePersisted: true,
        }),
        f.machineKeys.privateKey,
      )
      expect((await f.handoffs.commit(f.credentials.alice, next.handoffID)).currentDriver).toBe(
        privateRuntime.runtimeID,
      )
      const app = handoffMachineRoutes(() => f.handoffs)
      const response = await app.fetch(
        new Request("https://organization.example/handoffs/proof", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(oldSigned),
        }),
      )
      expect(response.status).toBe(200)
      const acknowledgement = await response.json()
      expect(acknowledgement).toEqual({
        ...tuple(original),
        purpose: "target-prepared",
        factHash: await Handoff.proofHash(oldFact),
      })
      expect(acknowledgement).not.toHaveProperty("currentDriver")
      expect(acknowledgement).not.toHaveProperty("bindingEpoch")
      expect(JSON.stringify(acknowledgement)).not.toContain(privateRuntime.runtimeID)
    })
  } finally {
    privateSocket?.close()
  }
})

test("handoff reserves a monotonic epoch and requires exact target consent while blocking conflicting commands", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const input = {
      handoffID: "handoff-1",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    }
    await expect(f.handoffs.prepare(f.credentials.bob, f.sessionID, input)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    const prepared = await f.handoffs.prepare(f.credentials.alice, f.sessionID, input)
    expect(prepared).toMatchObject({
      phase: "preparing",
      sourceRuntimeID: "runtime-alice",
      targetRuntimeID: "runtime-bob",
      fromEpoch: 1,
      toEpoch: 2,
      targetAccepted: false,
    })
    expect(await f.handoffs.prepare(f.credentials.alice, f.sessionID, input)).toEqual(prepared)
    await expect(
      OrganizationSharing.unshare(f.credentials.alice, f.sessionID, { expectedShareGeneration: 1 }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    await expect(f.commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(f.handoffs.accept(f.credentials.bob, "handoff-1", { mappingPlanRevision: 2 })).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT" },
    })
    expect(await f.handoffs.accept(f.credentials.bob, "handoff-1", { mappingPlanRevision: 1 })).toMatchObject({
      targetAccepted: true,
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.nextBindingEpoch).toBe(3)
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
  })
})

test("signed source and target facts commit once and activation remains a separate paused publication", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const state = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
      handoffID: "handoff-2",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    })
    await f.handoffs.accept(f.credentials.bob, state.handoffID, { mappingPlanRevision: 1 })
    const tuple = {
      schemaVersion: 1 as const,
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID: state.handoffID,
      sessionID: f.sessionID,
      sourceRuntimeID: "runtime-alice",
      targetRuntimeID: "runtime-bob",
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 1,
      manifestHash: "a".repeat(64),
    }
    async function publish(proof: Handoff.Proof, key: CryptoKey) {
      return f.handoffs.proof({ proof, signature: await Handoff.signProof(proof, key) })
    }
    const frozen = Handoff.Proof.parse({
      ...tuple,
      purpose: "source-frozen",
      commandSeq: state.commandSeq,
      receivedSeq: state.commandSeq,
      compatibilityHash: "b".repeat(64),
      closureHash: "c".repeat(64),
      fileClosureHash: null,
      workspaceMoveReceiptHash: null,
      paused: true,
      drained: true,
    })
    await publish(frozen, f.machineKeys.privateKey)
    const prepared = Handoff.Proof.parse({
      ...tuple,
      purpose: "target-prepared",
      compatibilityHash: "b".repeat(64),
      convertedHash: "d".repeat(64),
      closureHash: "c".repeat(64),
      fileClosureHash: null,
      workspaceMoveReceiptHash: null,
      paused: true,
    })
    if (prepared.purpose !== "target-prepared") throw new Error("Fixture requires its target preparation")
    await expect(
      publish({ ...prepared, fileClosureHash: "e".repeat(64) }, f.targetKeys.privateKey),
    ).rejects.toMatchObject({
      data: { code: "HANDOFF_BLOCKED" },
    })
    await publish(prepared, f.targetKeys.privateKey)
    await expect(f.handoffs.commit(f.credentials.alice, state.handoffID)).rejects.toMatchObject({
      data: { code: "HANDOFF_BLOCKED" },
    })
    const surrender = await (async () => {
      const sign = f.signing.signHandoff
      const issued = spyOn(f.signing, "signHandoff").mockImplementation(sign)
      try {
        const lost = new Error("The committed permit response was lost")
        await expect(
          (async () => {
            await f.handoffs.permit(f.credentials.alice, state.handoffID, { purpose: "handoff-surrender" })
            throw lost
          })(),
        ).rejects.toBe(lost)
        const recovered = await f.handoffs.permit(f.credentials.alice, state.handoffID, {
          purpose: "handoff-surrender",
        })
        expect(await f.handoffs.permit(f.credentials.alice, state.handoffID, { purpose: "handoff-surrender" })).toEqual(
          recovered,
        )
        expect(issued).toHaveBeenCalledTimes(1)
        return recovered
      } finally {
        issued.mockRestore()
      }
    })()
    const directory = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    expect(surrender.permit.sourceBinding).toEqual({
      schemaVersion: 1,
      orgID: directory.orgID,
      projectID: directory.projectID,
      creatorID: directory.creatorID,
      driverRuntimeID: tuple.sourceRuntimeID,
      bindingEpoch: tuple.fromEpoch,
    })
    expect(await Handoff.verifyPermit(surrender.permit, surrender.signature, f.signing.identity.publicKey)).toBe(true)
    expect(
      await Handoff.verifyPermit(
        { ...surrender.permit, sourceBinding: { ...surrender.permit.sourceBinding!, creatorID: "another-creator" } },
        surrender.signature,
        f.signing.identity.publicKey,
      ),
    ).toBe(false)
    const surrendered = Handoff.Proof.parse({
      ...tuple,
      purpose: "source-surrendered",
      permitID: surrender.permit.permitID,
      preparedHash: await Handoff.proofHash(prepared),
      gatePersisted: true,
    })
    await f.handoffs.cancel(f.credentials.alice, state.handoffID)
    await publish(surrendered, f.machineKeys.privateKey)
    f.connections.revoke("runtime-alice")
    const committed = await f.handoffs.commit(f.credentials.alice, state.handoffID)
    expect(committed.phase).toBe("committed")
    expect(await f.handoffs.commit(f.credentials.alice, state.handoffID)).toEqual(committed)
    const activation = await f.handoffs.permit(f.credentials.bob, state.handoffID, { purpose: "handoff-activation" })
    expect(activation.permit.sourceBinding).toEqual(surrender.permit.sourceBinding)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBe(state.handoffID)
    const activated = Handoff.Proof.parse({
      ...tuple,
      purpose: "target-activated",
      permitID: activation.permit.permitID,
      preparedHash: await Handoff.proofHash(prepared),
      paused: true,
    })
    expect(await publish(activated, f.targetKeys.privateKey)).toMatchObject({
      purpose: "target-activated",
      factHash: await Handoff.proofHash(activated),
    })
    const completed = await f.handoffs.get(f.credentials.bob, state.handoffID)
    expect(completed).toMatchObject({
      phase: "completed",
      currentDriver: "runtime-bob",
      bindingEpoch: 2,
      canContinue: true,
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBeUndefined()
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    await expect(
      publish(
        Handoff.Proof.parse({
          ...tuple,
          purpose: "target-never-activate",
          preparedHash: await Handoff.proofHash(prepared),
          tombstonePersisted: true,
        }),
        f.targetKeys.privateKey,
      ),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
  })
})

test("cancellation retains the handoff lock until a source proof and never reuses its reserved epoch", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const request = {
      handoffID: "cancel-first",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    }
    const first = await f.handoffs.prepare(f.credentials.alice, f.sessionID, request)
    await f.handoffs.cancel(f.credentials.alice, first.handoffID)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBe(first.handoffID)
    const proof = Handoff.Proof.parse({
      schemaVersion: 1,
      purpose: "source-cancelled",
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID: first.handoffID,
      sessionID: f.sessionID,
      sourceRuntimeID: first.sourceRuntimeID,
      targetRuntimeID: first.targetRuntimeID,
      fromEpoch: first.fromEpoch,
      toEpoch: first.toEpoch,
      mappingPlanRevision: 1,
      shareGeneration: 1,
      manifestHash: null,
      gateCancelled: true,
      paused: true,
    })
    const signed = { proof, signature: await Handoff.signProof(proof, f.machineKeys.privateKey) }
    await expect(f.handoffs.proof({ ...signed, signature: "0".repeat(128) })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    const acknowledgement = await f.handoffs.proof(signed)
    expect(acknowledgement).toMatchObject({ purpose: "source-cancelled", factHash: await Handoff.proofHash(proof) })
    expect(await f.handoffs.get(f.credentials.alice, first.handoffID)).toMatchObject({
      phase: "cancelled",
      currentDriver: "runtime-alice",
      bindingEpoch: 1,
    })
    expect(await f.handoffs.proof(signed)).toEqual(acknowledgement)
    const second = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
      ...request,
      handoffID: "after-cancel",
      expectedControlRevision: 2,
    })
    expect(second.toEpoch).toBe(3)
    await expect(
      f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        ...request,
        handoffID: "concurrent",
        expectedControlRevision: 3,
      }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
  })
})

test("project archive sees a late private handoff and waits for its actual cancellation proof", async () => {
  await using f = await fixture("alice")
  await f.run(async () => {
    for (let index = 0; index < 128; index++)
      await OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
        sessionID: "ses_page_" + String(index).padStart(3, "0"),
        projectID: "project",
        runtimeID: "runtime-alice",
      })
    const sessionID = "ses_z_pending"
    await OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
      sessionID,
      projectID: "project",
      runtimeID: "runtime-alice",
    })
    const pending = await f.handoffs.prepare(f.credentials.alice, sessionID, {
      handoffID: "private-archive-blocker",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    })
    await expect(OrganizationSessionDirectory.get(f.credentials.admin, sessionID)).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    const project = await OrganizationProjects.get(f.credentials.admin, "project")
    const archive = () =>
      OrganizationProjects.update(f.credentials.admin, "project", {
        expectedRevision: project.revision,
        state: "archived",
      })
    await expect(archive()).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    expect(await OrganizationProjects.get(f.credentials.admin, "project")).toEqual(project)
    const independent = await OrganizationProjects.create(f.credentials.admin, { name: "Independent", description: "" })
    expect(
      (
        await OrganizationProjects.update(f.credentials.admin, independent.projectID, {
          expectedRevision: independent.revision,
          state: "archived",
        })
      ).state,
    ).toBe("archived")
    await f.handoffs.cancel(f.credentials.alice, pending.handoffID)
    await expect(archive()).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    const proof = Handoff.Proof.parse({
      schemaVersion: 1,
      purpose: "source-cancelled",
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID: pending.handoffID,
      sessionID,
      sourceRuntimeID: pending.sourceRuntimeID,
      targetRuntimeID: pending.targetRuntimeID,
      fromEpoch: pending.fromEpoch,
      toEpoch: pending.toEpoch,
      mappingPlanRevision: 1,
      shareGeneration: 0,
      manifestHash: null,
      gateCancelled: true,
      paused: true,
    })
    expect(
      await f.handoffs.proof({ proof, signature: await Handoff.signProof(proof, f.machineKeys.privateKey) }),
    ).toMatchObject({ purpose: "source-cancelled", factHash: await Handoff.proofHash(proof) })
    expect(await f.handoffs.get(f.credentials.alice, pending.handoffID)).toMatchObject({
      phase: "cancelled",
      bindingEpoch: 1,
    })
    const archived = await archive()
    expect(archived.state).toBe("archived")
    expect((await OrganizationSessionDirectory.get(f.credentials.alice, sessionID)).permissions.execute).toBe(false)
    const paused = await Record.read(Record.SessionDirectory, Keys.session(sessionID))
    const restored = await OrganizationProjects.update(f.credentials.admin, "project", {
      expectedRevision: archived.revision,
      state: "active",
    })
    expect(restored.state).toBe("active")
    expect(await Record.read(Record.SessionDirectory, Keys.session(sessionID))).toEqual(paused)
  })
})

for (const first of ["handoff", "archive"] as const)
  test(`${first} committing first determines project archive versus new handoff admission`, async () => {
    await using f = await fixture("alice")
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const rescue = setTimeout(() => release.resolve(), 10_000)
    const prepare = () =>
      f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "archive-admission-race",
        targetRuntimeID: "runtime-bob",
        expectedBindingEpoch: 1,
        expectedControlRevision: 0,
        mappingPlanRevision: 1,
      })
    const archive = () =>
      OrganizationProjects.update(f.credentials.admin, "project", { expectedRevision: 1, state: "archived" })
    const winner = Promise.resolve(
      f.run(() =>
        Storage.transaction(async () => {
          const result = first === "handoff" ? await prepare() : await archive()
          admitted.resolve()
          await release.promise
          return result
        }),
      ),
    )
    try {
      await Promise.race([
        admitted.promise,
        winner.then(
          () => {},
          (error: unknown) => Promise.reject(error),
        ),
      ])
      const loser = Promise.resolve(f.run(async () => (first === "handoff" ? archive() : prepare()))).then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      )
      release.resolve()
      await winner
      expect(await loser).toMatchObject({
        ok: false,
        error: { data: { code: first === "handoff" ? "HANDOFF_BLOCKED" : "PERMISSION_DENIED" } },
      })
      await f.run(async () => {
        expect((await Record.read(Record.Project, Keys.project("project")))?.state).toBe(
          first === "handoff" ? "active" : "archived",
        )
        expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBe(
          first === "handoff" ? "archive-admission-race" : undefined,
        )
        expect((await AuthorityJournal.inspect()).covered).toBe(true)
      })
    } finally {
      clearTimeout(rescue)
      release.resolve()
      await winner.catch(() => {})
    }
  })

test("reader seven rejects explicit Environment mapping before source inspection, freeze, or admission", async () => {
  await using f = await fixture("bob", 7)
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const original = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    let outcome: unknown
    try {
      await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        handoffID: "unsupported-environment-map",
        targetRuntimeID: "runtime-bob",
        expectedBindingEpoch: original.bindingEpoch,
        expectedControlRevision: original.controlRevision,
        mappingPlanRevision: 1,
        workspaceMapping: { kind: "native" },
        environmentMapping: {
          version: 1,
          expectedSelectionRevision: 0,
          source: { kind: "none" },
          target: { kind: "none" },
        },
      })
    } catch (error) {
      outcome = error
    }
    expect(outcome).toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    if (!(outcome instanceof Error)) throw new Error("Expected the original compatibility refusal")
    expect(outcome.message).toContain("Environment")
    expect(await Record.read(Record.SessionDirectory, Keys.session(f.sessionID))).toEqual(original)
    expect(await Storage.count({ prefix: ["organization", "handoffs"] })).toBe(0)
  })
})
