import { commandFixture as fixture } from "./support/commands"
import { expect, spyOn, test } from "bun:test"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { createRuntimeConnections } from "../src/runtime-connection"
import { OrganizationStoragePath as Paths } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { createCommandAdmissions } from "../src/command-admission"
import { ClientPolicy } from "../src/auth/client-policy"
import { digest } from "../src/auth/secret"

for (const operation of ["pause", "cancel"] as const)
  test(`${operation} remains authorized on archived projects while Continue, readers and management-only accounts are refused`, async () => {
    await using f = await fixture()
    await f.connect()
    await f.run(async () => {
      const { input: _, ...target } = f.request()
      const pause: Command.ControlRequest = {
        ...target,
        control: operation === "pause" ? { operation } : { operation, runID: "task", controlVersion: 0 },
      }
      await expect(f.commands.control(f.credentials.owner, pause)).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
      const session = (await Record.read(Record.SessionDirectory, Paths.session(f.sessionID)))!
      await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared" })
      const project = (await Record.read(Record.Project, Paths.project("project")))!
      await Storage.write(Paths.project("project"), { ...project, state: "archived" })
      for (const actor of ["owner", "admin", "reader"])
        await expect(f.commands.control(f.credentials[actor], pause)).rejects.toMatchObject({
          data: { code: "PERMISSION_DENIED" },
        })
      await expect(
        f.commands.control(f.credentials.bob, {
          ...pause,
          control: { operation: "continue", pausedSince: 100, controlVersion: 1 },
        }),
      ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
      await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared", handoffID: "handoff" })
      await expect(f.commands.control(f.credentials.bob, pause)).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
      await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared" })
      const admitted = await f.commands.control(f.credentials.bob, pause)
      expect(admitted.kind).toBe("admitted")
      if (admitted.kind !== "admitted") throw new Error("Expected pause admission")
      const permit = admitted.delivery.authorization.permit
      expect(permit.actor.subjectID).toBe("bob")
      expect(permit.operation).toBe(operation)
      expect(permit.payloadHash).toBe(await Command.digestControl(pause))
      expect(
        await Command.verify(permit, admitted.delivery.authorization.signature, f.signing.identity.publicKey),
      ).toBe(true)
    })
  })

test("service admission requires a live capable Runtime and stores only authorization metadata", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await expect(f.commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "RUNTIME_OFFLINE" },
    })
  })
  await f.connect()
  await f.run(async () => {
    const result = await f.commands.input(f.credentials.alice, f.request())
    expect(result.kind).toBe("admitted")
    if (result.kind !== "admitted") throw new Error("Expected service authorization")
    const { permit, signature } = result.delivery.authorization
    expect(permit.actor).toMatchObject({ subjectID: "alice", orgID: "org", clientKind: "web", requestID: "request" })
    expect(permit.commandSeq).toBe(1)
    expect(permit.connectionEpoch).toBe(1)
    expect(await Command.verify(permit, signature, f.signing.identity.publicKey)).toBe(true)
    expect(await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).toMatchObject({
      attempt: { state: "admitted" },
    })
    const rows = await Storage.current().store.query({ prefix: ["organization", "command-requests"] })
    const attempts = await Storage.current().store.query({ prefix: ["organization", "command-attempts"] })
    expect(rows).toHaveLength(1)
    expect(attempts).toHaveLength(1)
    expect(JSON.stringify([...rows, ...attempts].map((row) => row.value))).not.toContain(
      "Private input stays out of service storage",
    )
  })
})

function accepted(permit: Command.Permit): Command.InputResult {
  return Command.InputResult.parse({
    attempt: {
      schemaVersion: 1,
      permit,
      receivedAt: Date.now(),
      status: "accepted",
      acceptedAttemptID: permit.attemptID,
    },
    accepted: {
      schemaVersion: 1,
      permit,
      acceptedAt: Date.now(),
      intakeSeq: 1,
      effect: { kind: "inbox", itemID: "inb_admission", messageID: "msg_admission", mode: "context" },
    },
  })
}

test("creation reserves its directory and authorization atomically for the current member's own Runtime", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const request: Command.CreateRequest = {
      schemaVersion: 1,
      orgID: "org",
      projectID: "project",
      runtimeID: "runtime-alice",
      requestID: "create",
      creation: { operation: "create", title: "Private service creation" },
    }
    await expect(f.commands.create(f.credentials.owner, request)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(f.commands.create(f.credentials.bob, request)).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
    const write = Storage.write
    const failed = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] === "command-attempts") throw new Error("Admission write failed")
    })
    try {
      await expect(f.commands.create(f.credentials.alice, request)).rejects.toThrow("Admission write failed")
    } finally {
      failed.mockRestore()
    }
    expect(await Storage.count({ prefix: ["organization", "sessions"] })).toBe(1)
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(0)
    const results = await Promise.allSettled([
      f.commands.create(f.credentials.alice, request),
      f.commands.create(f.credentials.alice, request),
    ])
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1)
    const original = await f.commands.get(f.credentials.alice, { requestID: "create" })
    expect(original.attempt.state).toBe("admitted")
    const permit = original.attempt.authorization.permit
    expect(permit.sessionID).toStartWith("ses_")
    expect(permit.operation).toBe("create")
    expect(permit.actor.subjectID).toBe("alice")
    expect(permit.payloadHash).toBe(await Command.digestCreate({ ...request, sessionID: permit.sessionID }))
    expect(await Storage.count({ prefix: ["organization", "sessions"] })).toBe(2)
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
    await expect(
      f.commands.inspectCreate(f.credentials.alice, {
        ...request,
        creation: { operation: "create", title: "Changed" },
      }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  })
})

test("current project access and capable connections gate A without granting administrators private content", async () => {
  await using f = await fixture()
  await f.connect(1, false)
  await f.run(async () => {
    await expect(f.commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "PROTOCOL_MISMATCH" },
    })
    for (const actor of ["owner", "admin", "bob", "reader", "outsider", "foreign"])
      await expect(f.commands.input(f.credentials[actor], f.request())).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
  })
  await f.connect(2)
  await f.run(async () => {
    const session = (await Record.read(Record.SessionDirectory, Paths.session(f.sessionID)))!
    await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared" })
    for (const actor of ["owner", "admin", "reader"])
      await expect(f.commands.input(f.credentials[actor], f.request())).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
    const project = (await Record.read(Record.Project, Paths.project("project")))!
    await Storage.write(Paths.project("project"), { ...project, state: "archived" })
    await expect(f.commands.input(f.credentials.bob, f.request())).rejects.toThrow()
    await Storage.write(Paths.project("project"), project)
    await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared", handoffID: "handoff" })
    await expect(f.commands.input(f.credentials.bob, f.request())).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await Storage.write(Paths.session(f.sessionID), { ...session, shareState: "shared" })
    const result = await f.commands.input(f.credentials.bob, f.request())
    expect(result.kind).toBe("admitted")
    if (result.kind === "admitted") expect(result.delivery.authorization.permit.actor.subjectID).toBe("bob")
  })
})

test("client attribution comes from the validated grant and input is captured before digest work", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const client = {
      clientID: "desktop-client",
      kind: "desktop" as const,
      redirectUri: "synergy://organization-auth/callback" as const,
    }
    ClientPolicy.configure("https://organization.example", [client])
    const token = "f".repeat(64)
    await Storage.write(
      Paths.clientGrant("grant"),
      Record.ClientGrant.parse({
        schemaVersion: 1,
        grantID: "grant",
        clientID: client.clientID,
        clientHash: ClientPolicy.fingerprint(client),
        loginHash: digest(f.credentials.alice.token),
        issuer: "https://organization.example",
        orgID: "org",
        deploymentIncarnation: "deployment",
        expiresAt: Date.now() + 60_000,
      }),
    )
    await Storage.write(Paths.clientAccess(digest(token)), {
      schemaVersion: 1,
      tokenHash: digest(token),
      grantID: "grant",
      expiresAt: Date.now() + 60_000,
    })
    const credentials = { token, kind: "access" as const }
    const request = f.request()
    const pending = f.commands.input(credentials, request)
    credentials.token = "e".repeat(64)
    request.input.parts[0].text = "Changed after submission"
    const result = await pending
    if (result.kind !== "admitted") throw new Error("Expected admission")
    expect(result.delivery.authorization.permit.actor).toMatchObject({ subjectID: "alice", clientKind: "desktop" })
    expect(result.delivery.input.parts[0].text).toBe("Private input stays out of service storage")
    expect(result.delivery.authorization.permit.payloadHash).toBe(await Command.digestInput(f.request()))
    expect(Object.isFrozen(result.connection.handshake)).toBe(true)
    expect(Object.isFrozen(result.connection.handshake.schemas)).toBe(true)
    await expect(
      f.commands.input(f.credentials.alice, { ...f.request(), actor: { subjectID: "bob" } } as Command.InputRequest),
    ).rejects.toThrow()
  })
})

test("concurrent requests preserve one unresolved attempt and changed logical payloads conflict", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const results = await Promise.allSettled([
      f.commands.input(f.credentials.alice, f.request()),
      f.commands.input(f.credentials.alice, f.request()),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason.data).toMatchObject({
      code: "COMMAND_OUTCOME_UNKNOWN",
      outcome: "unknown",
      requestID: "request",
    })
    await expect(f.commands.input(f.credentials.alice, f.request("request", "Changed payload"))).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT" },
    })
    await expect(f.commands.input(f.credentials.alice, f.request("next-request"))).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT", outcome: "not_dispatched" },
    })
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
    expect(await Storage.read(Paths.commandState(f.sessionID))).toMatchObject({ commandSeq: 1 })
  })
})

test("admission rollback includes authorization, request and sequence when its connection or deadline ends", async () => {
  for (const cause of ["disconnect", "deadline"] as const) {
    await using f = await fixture()
    await f.connect()
    await f.run(async () => {
      const original = Storage.write
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
      const write = spyOn(Storage, "write").mockImplementation(async <T>(key: string[], value: T) => {
        await original(key, value)
        if (key[1] !== "command-attempts") return
        if (cause === "disconnect") f.connections.revoke("runtime-alice")
        else
          clock = spyOn(Date, "now").mockReturnValue(Record.CommandAttempt.parse(value).authorization.permit.deadline)
      })
      try {
        await expect(f.commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
          data: { code: "RUNTIME_OFFLINE" },
        })
      } finally {
        write.mockRestore()
        clock?.mockRestore()
      }
      for (const domain of [
        "command-attempts",
        "command-requests",
        "command-states",
        "session-commands",
        "request-attempts",
      ])
        expect(await Storage.count({ prefix: ["organization", domain] })).toBe(0)
    })
  }
})

test("an earlier A can reconcile B after project revocation while later admission and reads are denied", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const result = await f.commands.input(f.credentials.alice, f.request())
    if (result.kind !== "admitted") throw new Error("Expected admission")
    const permit = result.delivery.authorization.permit
    await f.commands.dispatch(permit.attemptID, result.connection)
    await Storage.remove(Paths.projectMember("project", "alice"))
    const receipt = accepted(permit)
    expect((await f.commands.observe(result.connection, receipt)).state).toBe("accepted")
    expect(
      (await Storage.read<ReturnType<typeof Record.CommandRequest.parse>>(Paths.commandRequest("alice", "request")))
        .accepted,
    ).toEqual(receipt.accepted)
    await expect(f.commands.input(f.credentials.alice, f.request("new-request"))).rejects.toThrow()
    await expect(
      f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" }),
    ).rejects.toThrow()
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
  })
})

test("transmission uncertainty never becomes acceptance and a matching B receipt wins over a late timeout", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const result = await f.commands.input(f.credentials.alice, f.request())
    if (result.kind !== "admitted") throw new Error("Expected admission")
    const permit = result.delivery.authorization.permit
    await expect(f.commands.unknown(permit.attemptID)).rejects.toThrow()
    await f.commands.dispatch(permit.attemptID, result.connection)
    await expect(f.commands.notDispatched(permit.attemptID)).rejects.toThrow()
    expect((await f.commands.unknown(permit.attemptID)).state).toBe("unknown")
    await expect(f.commands.prepareSkip(permit.attemptID, result.connection)).rejects.toThrow()
    const receipt = accepted(permit)
    const changed = structuredClone(receipt)
    changed.attempt.permit.payloadHash = "0".repeat(64)
    await expect(f.commands.observe(result.connection, changed)).rejects.toThrow()
    expect(
      (await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })).accepted,
    ).toBeUndefined()
    await f.commands.observe(result.connection, receipt)
    expect((await f.commands.unknown(permit.attemptID)).state).toBe("accepted")
    const replacement = structuredClone(receipt)
    replacement.accepted!.effect.messageID = "msg_replacement"
    await expect(f.commands.observe(result.connection, replacement)).rejects.toThrow()
    f.connections.revoke("runtime-alice")
    const membership = (await Record.read(Record.ProjectMember, Paths.projectMember("project", "alice")))!
    await Storage.write(Paths.projectMember("project", "alice"), { ...membership, role: "reader" })
    expect(await f.commands.input(f.credentials.alice, f.request())).toEqual({
      kind: "accepted",
      receipt: receipt.accepted!,
    })
    expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
  })
})

test("only an issued skip settles an unsent attempt and old skip proof remains reconcilable after reconnect", async () => {
  await using f = await fixture()
  await f.connect()
  const first = await f.run(() => f.commands.input(f.credentials.alice, f.request()))
  if (first.kind !== "admitted") throw new Error("Expected admission")
  const permit = first.delivery.authorization.permit
  const original = await f.run(async () => {
    await f.commands.notDispatched(permit.attemptID)
    const proof = await f.commands.prepareSkip(permit.attemptID, first.connection)
    expect(await f.commands.prepareSkip(permit.attemptID, first.connection)).toEqual(proof)
    return proof
  })
  await f.connect(2)
  await f.run(async () => {
    const connection = f.connections.capture("runtime-alice")
    const replacement = await f.commands.prepareSkip(permit.attemptID, connection)
    expect(replacement.permit.connectionEpoch).toBe(2)
    const result: Command.Result = {
      attempt: { schemaVersion: 1, permit, receivedAt: Date.now(), status: "skipped" },
      skip: { schemaVersion: 1, permit: original.permit, receivedAt: Date.now() },
    }
    const forged = structuredClone(result)
    forged.skip!.permit.authorizedAt++
    await expect(f.commands.observe(connection, forged)).rejects.toThrow()
    await f.commands.observe(connection, result)
    const retry = await f.commands.input(f.credentials.alice, f.request())
    if (retry.kind !== "admitted") throw new Error("Expected retry admission")
    expect(retry.delivery.authorization.permit.commandSeq).toBe(2)
    expect(retry.delivery.authorization.permit.attemptID).not.toBe(permit.attemptID)
    await f.commands.observe(connection, result)
    expect(await Storage.read(Paths.commandState(f.sessionID))).toMatchObject({
      pendingAttemptID: retry.delivery.authorization.permit.attemptID,
    })
    await expect(f.commands.dispatch(retry.delivery.authorization.permit.attemptID, first.connection)).rejects.toThrow()
  })
})

test("restart retains unresolved receipts without turning them into a dispatch queue", async () => {
  await using f = await fixture()
  await f.connect()
  const first = await f.run(() => f.commands.input(f.credentials.alice, f.request()))
  if (first.kind !== "admitted") throw new Error("Expected admission")
  f.connections.close()
  await f.restart()
  const connections = createRuntimeConnections({
    run: async (body) => f.run(body),
    signingIdentity: f.signing.identity,
  })
  const commands = createCommandAdmissions({ connections, signing: f.signing })
  try {
    await f.run(async () => {
      const stored = await commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
      expect(stored.attempt.authorization).toEqual(first.delivery.authorization)
      expect(stored.attempt.state).toBe("admitted")
      expect(stored.accepted).toBeUndefined()
      expect(() => connections.capture("runtime-alice")).toThrow()
      await expect(commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
        data: { code: "COMMAND_OUTCOME_UNKNOWN" },
      })
      expect(await Storage.count({ prefix: ["organization", "command-attempts"] })).toBe(1)
    })
  } finally {
    connections.close()
  }
})

test("dispatch and skip preparation retain their prior state when the permit expires before commit", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    const prepared = await f.commands.input(f.credentials.alice, f.request())
    if (prepared.kind !== "admitted") throw new Error("Expected admission")
    const permit = prepared.delivery.authorization.permit
    for (const operation of ["dispatch", "skip"] as const) {
      if (operation === "skip") await f.commands.notDispatched(permit.attemptID)
      const original = Storage.write
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
      const write = spyOn(Storage, "write").mockImplementation(async <T>(key: string[], value: T) => {
        await original(key, value)
        if (key[1] !== "command-attempts") return
        const row = Record.CommandAttempt.parse(value)
        clock = spyOn(Date, "now").mockReturnValue(
          operation === "dispatch" ? permit.deadline : row.skip!.permit.deadline,
        )
      })
      try {
        await expect(
          operation === "dispatch"
            ? f.commands.dispatch(permit.attemptID, prepared.connection)
            : f.commands.prepareSkip(permit.attemptID, prepared.connection),
        ).rejects.toThrow()
      } finally {
        write.mockRestore()
        clock?.mockRestore()
      }
      const current = await f.commands.get(f.credentials.alice, { sessionID: f.sessionID, requestID: "request" })
      expect(current.attempt.state).toBe(operation === "dispatch" ? "admitted" : "not_dispatched")
      expect(current.attempt.skip).toBeUndefined()
    }
    expect(await Storage.count({ prefix: ["organization", "command-skips"] })).toBe(0)
  })
})
