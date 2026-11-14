import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { prepareHostedHome } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { openHostedRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { observeTaskFailure } from "./support/task-failure"
import { ModelRequest, modelResponse, runtimeContext, waitKnowledgeTask } from "./support/knowledge-task"

const Request = ModelRequest.extend({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
})

test("actual Hosted session_read preserves the current root and shared access while rejecting another creator's private history", async () => {
  await using service = await fixture({ connections: { heartbeatMs: 25 } })
  const ownerOptions = { headers: service.headers, throwOnError: true as const }
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Hosted cross-object authority", description: "" } },
      ownerOptions,
    )
  ).data
  const invitation = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, ownerOptions))
    .data
  const password = "a separate hosted reader integration password"
  const collaborator = (
    await service.client.orgInvites.consume(
      {
        orgInviteConsume: {
          token: invitation.token,
          requestID: "cross-object-collaborator",
          loginName: "reader",
          displayName: "Reader",
          password,
        },
      },
      { throwOnError: true },
    )
  ).data
  const login = await service.client.orgAuth.login(
    { orgLoginInput: { loginName: "reader", password } },
    { throwOnError: true },
  )
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("The actual collaborator login did not establish a session")
  const collaboratorHeaders = { cookie, "x-csrf-token": login.data.csrfToken }
  await service.client.orgProjects.member(
    {
      projectID: project.projectID,
      accountID: collaborator.accountID,
      orgProjectMemberChange: { expectedRevision: project.revision, role: "collaborator" },
    },
    ownerOptions,
  )
  const home = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "cross-object-host" },
    origin: service.origin,
  })
  const ticket = (
    await service.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Cross-object host", publicKey: home.publicKey } },
      ownerOptions,
    )
  ).data
  const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
  const online = Promise.withResolvers<void>()
  service.interceptFrames((_socket, raw) => {
    if (Protocol.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
    return false
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port
  if (!port) throw new Error("The isolated Hosted listener did not reserve a port")
  await probe.stop(true)
  await using runtime = await openHostedRuntime({
    home: home.home,
    identity: home.identity,
    ca: service.ca,
    listen: { port, token: "d".repeat(64) },
  })
  try {
    await online.promise
  } finally {
    service.interceptFrames(undefined)
  }
  const requests: Array<z.infer<typeof Request>> = []
  const heldSync: Array<() => unknown> = []
  let active: { target?: string; step: number; started: () => void } | undefined
  type TerminalFailure = { kind: "failed"; error: NonNullable<MessageV2.Assistant["error"]> }
  let producer:
    | {
        sessionID: string
        rootID?: string
        early: Map<string, TerminalFailure>
        resolve(outcome: TerminalFailure): void
      }
    | undefined
  let unsubscribe: (() => void) | undefined
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = Request.parse(await request.json())
      requests.push(input)
      if (!runtimeContext(input)) return modelResponse(requests.length)
      const task = active
      if (!task) throw new Error("An actual model request escaped its accepted task")
      task.started()
      task.step++
      if (!task.target || task.step > 2) return modelResponse(requests.length)
      const name = task.step === 1 ? "expand_tools" : "session_read"
      if (!input.tools?.some((tool) => tool.function.name === name))
        throw new Error(`The actual model catalog did not offer ${name}`)
      return modelResponse(requests.length, {
        name,
        input: task.step === 1 ? { groups: ["session"] } : { target: task.target, limit: 50, offset: 0 },
      })
    },
  })
  try {
    unsubscribe = await runtime.run(() =>
      Bus.subscribeGlobal(MessageV2.Event.Updated, (event) => {
        const task = producer
        const info = event.properties.info
        if (
          !task ||
          info.sessionID !== task.sessionID ||
          info.role !== "assistant" ||
          info.rootID === undefined ||
          info.error === undefined ||
          info.time.completed === undefined
        )
          return
        const outcome: TerminalFailure = { kind: "failed", error: info.error }
        if (task.rootID === undefined) task.early.set(info.rootID, outcome)
        else if (info.rootID === task.rootID) task.resolve(outcome)
      }),
    )
    const model = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Cross-object model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: new URL("/v1", upstream.url).href,
              model: { id: "knowledge-model", name: "Cross-object", limit: { context: 128000, output: 4096 } },
            },
            credential: { kind: "bearer", value: "cross-object-model-key" },
          },
        },
        ownerOptions,
      )
    ).data
    for (const subjectID of [service.identity.accountID, collaborator.accountID])
      await service.client.orgResourceGrants.set(
        {
          resourceID: model.resourceID,
          kind: "account",
          subjectID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        ownerOptions,
      )
    const create = async (headers: Record<string, string>, requestID: string) => {
      const created = (
        await service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              schemaVersion: 1,
              orgID: service.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              requestID,
              creation: { operation: "create", title: requestID },
            },
          },
          { headers, throwOnError: true },
        )
      ).data
      const sessionID = created.effect.sessionID
      await service.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [],
              infrastructure: { workspace: null, environment: null },
            },
          },
        },
        { headers, throwOnError: true },
      )
      return sessionID
    }
    const firstSessionID = await create(service.headers, "creator-private-history")
    const secondSessionID = await create(collaboratorHeaders, "reader-private-history")
    expect((await runtime.run(() => Session.get(firstSessionID))).organization).toMatchObject({
      creatorID: service.identity.accountID,
      driverRuntimeID: registration.runtimeID,
    })
    expect((await runtime.run(() => Session.get(secondSessionID))).organization).toMatchObject({
      creatorID: collaborator.accountID,
      driverRuntimeID: registration.runtimeID,
    })
    expect((await service.client.orgSessions.get({ sessionID: firstSessionID }, ownerOptions)).data.shareState).toBe(
      "private",
    )
    expect(
      (
        await service.client.orgSessions.get(
          { sessionID: secondSessionID },
          { headers: collaboratorHeaders, throwOnError: true },
        )
      ).data.shareState,
    ).toBe("private")
    expect([403, 404]).toContain(
      (await service.client.orgSessions.get({ sessionID: firstSessionID }, { headers: collaboratorHeaders })).response
        .status,
    )
    const run = async (
      sessionID: string,
      headers: Record<string, string>,
      requestID: string,
      text: string,
      target?: string,
    ) => {
      const started = Promise.withResolvers<void>()
      const failure = Promise.withResolvers<TerminalFailure>()
      producer = { sessionID, early: new Map(), resolve: failure.resolve }
      active = { target, step: 0, started: () => started.resolve() }
      const before = requests.length
      const accepted = (
        await service.client.orgCommands.input(
          {
            sessionID,
            orgCommandInputRequest: {
              schemaVersion: 1,
              orgID: service.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              sessionID,
              requestID,
              input: { operation: "input", mode: "task", parts: [{ type: "text", text }] },
            },
          },
          { headers, throwOnError: true },
        )
      ).data
      producer.rootID = accepted.effect.messageID
      const retained = producer.early.get(producer.rootID)
      producer.early.clear()
      if (retained) producer.resolve(retained)
      const outcome = await Promise.race([started.promise.then(() => ({ kind: "started" as const })), failure.promise])
      if (outcome.kind === "failed") {
        await observeTaskFailure({
          runtime,
          accepted,
          stage: "hosted-model-start",
          upstreamCalls: requests.length - before,
          contextCalls: requests.slice(before).filter((request) => runtimeContext(request) !== undefined).length,
        })
        throw outcome.error
      }
      const completed = await waitKnowledgeTask(runtime, accepted, () => requests.length - before, requestID)
      active = undefined
      producer = undefined
      const observed = requests.slice(before)
      const conversation = observed.filter((request) => runtimeContext(request) !== undefined)
      expect(conversation).toHaveLength(target ? 3 : 1)
      const recorded = await runtime.run(() => RolloutLedger.calls(completed.owner, completed.rootID))
      expect(recorded).toHaveLength(observed.length)
      expect(recorded.every((call) => call.status === "completed" && call.transportCaptured)).toBe(true)
      expect(recorded.filter((call) => call.usageRole === "conversation")).toMatchObject(
        conversation.map(() => ({ purpose: PrimaryAgentIdentity.names.general, status: "completed" })),
      )
      const tools = await runtime.run(() => RolloutLedger.tools(completed.owner, completed.rootID))
      const artifacts = await runtime.run(async () => {
        const result: Array<{ tool: string; kind: "input" | "rawResult" | "observation"; content: string }> = []
        for (const tool of tools)
          for (const kind of ["input", "rawResult", "observation"] as const) {
            const artifact = tool[kind]
            if (!artifact) continue
            const chunks: Uint8Array[] = []
            for await (const chunk of RolloutArtifact.read(completed.owner, artifact.id)) chunks.push(chunk)
            result.push({ tool: tool.tool, kind, content: Buffer.concat(chunks).toString() })
          }
        return result
      })
      if (target) {
        expect(tools.map((tool) => tool.tool).sort()).toEqual(["expand_tools", "session_read"])
        const input = artifacts.find((artifact) => artifact.tool === "session_read" && artifact.kind === "input")
        if (!input) throw new Error("The actual Session reader did not retain its original tool input")
        expect(JSON.parse(input.content)).toMatchObject({ target })
      }
      return { accepted, observed, tools, artifacts }
    }
    const sentinel = "Only the first creator witnessed the violet badger inside chamber seven."
    const first = await run(
      firstSessionID,
      service.headers,
      "seed-private-history",
      `${sentinel} Retain this private observation and finish without tools.`,
    )
    const original = await runtime.run(() =>
      MessageV2.get({ sessionID: firstSessionID, messageID: first.accepted.effect.messageID }),
    )
    expect(
      original.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).toContain(sentinel)
    const ownMarker = "The second creator can read this current root's amber otter."
    const own = await run(
      secondSessionID,
      collaboratorHeaders,
      "read-current-private-root",
      `${ownMarker} Read this Session ${secondSessionID} and finish.`,
      secondSessionID,
    )
    expect(own.tools.find((tool) => tool.tool === "session_read")?.status).toBe("completed")
    expect(
      own.artifacts.find((artifact) => artifact.tool === "session_read" && artifact.kind === "rawResult")?.content,
    ).toContain(ownMarker)
    const denied = await run(
      secondSessionID,
      collaboratorHeaders,
      "reject-guessed-private-root",
      `Read the guessed Session ${firstSessionID} and finish.`,
      firstSessionID,
    )
    await service.client.orgSessions.share(
      { sessionID: firstSessionID, orgShareChange: { expectedShareGeneration: 0 } },
      ownerOptions,
    )
    const projection = await (async () => {
      for (;;) {
        const page = (
          await service.client.orgSessionSync.snapshot({ sessionID: firstSessionID, limit: 128 }, ownerOptions)
        ).data
        const state = (await service.client.orgSessions.shareState({ sessionID: firstSessionID }, ownerOptions)).data
        if (state.syncState === "synced" && !page.cursor && JSON.stringify(page.items).includes(sentinel)) return page
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    })()
    const withheld = Promise.withResolvers<void>()
    service.interceptFrames((socket, raw) => {
      const payload = String(raw)
      const frame = Protocol.ClientFrame.parse(JSON.parse(payload))
      if (
        (frame.type === "sync-batch" && frame.batch.sessionID === firstSessionID) ||
        (frame.type === "blob-chunk" && frame.sessionID === firstSessionID)
      ) {
        heldSync.push(() => service.service.websocket.message(socket, payload))
        withheld.resolve()
        return true
      }
      return false
    })
    const unpublished = "The copper heron was recorded only in the first creator's later native context."
    const context = await run(
      firstSessionID,
      service.headers,
      "retain-not-yet-uploaded-history",
      `${unpublished} Retain this observation and finish without tools.`,
    )
    const nativeContext = await runtime.run(() =>
      MessageV2.get({ sessionID: firstSessionID, messageID: context.accepted.effect.messageID }),
    )
    expect(nativeContext.parts.some((part) => part.type === "text" && part.text.includes(unpublished))).toBe(true)
    await withheld.promise
    const shared = await run(
      secondSessionID,
      collaboratorHeaders,
      "read-explicitly-shared-root",
      `Read the now shared Session ${firstSessionID} and finish.`,
      firstSessionID,
    )
    expect(shared.tools.find((tool) => tool.tool === "session_read")?.status).toBe("completed")
    expect(
      shared.artifacts.find((artifact) => artifact.tool === "session_read" && artifact.kind === "rawResult")?.content,
    ).toContain(sentinel)
    const sharedResult = shared.artifacts.find(
      (artifact) => artifact.tool === "session_read" && artifact.kind === "rawResult",
    )
    if (!sharedResult) throw new Error("The authorized shared reader did not retain its projection")
    expect(JSON.parse(sharedResult.content)).toMatchObject({
      metadata: {
        sessionID: firstSessionID,
        shareGeneration: projection.shareGeneration,
        watermark: projection.watermark,
        projectionOnly: true,
      },
    })
    expect({
      rawResult: shared.artifacts.some((artifact) => artifact.content.includes(unpublished)),
      followingModel: shared.observed.some((request) => JSON.stringify(request).includes(unpublished)),
    }).toEqual({ rawResult: false, followingModel: false })
    const stillProjected = (
      await service.client.orgSessionSync.snapshot({ sessionID: firstSessionID, limit: 128 }, ownerOptions)
    ).data
    expect(stillProjected.watermark).toBe(projection.watermark)
    expect(JSON.stringify(stillProjected.items).includes(unpublished)).toBe(false)
    expect(
      await runtime.run(() => MessageV2.get({ sessionID: firstSessionID, messageID: first.accepted.effect.messageID })),
    ).toEqual(original)
    const privateVisibility = {
      rawResult: denied.artifacts.some(
        (artifact) =>
          artifact.tool === "session_read" && artifact.kind === "rawResult" && artifact.content.includes(sentinel),
      ),
      observation: denied.artifacts.some(
        (artifact) =>
          artifact.tool === "session_read" && artifact.kind === "observation" && artifact.content.includes(sentinel),
      ),
      followingModel: denied.observed
        .filter((request) => runtimeContext(request) !== undefined)
        .slice(2)
        .some((request) => JSON.stringify(request).includes(sentinel)),
      anyModel: denied.observed.some((request) => JSON.stringify(request).includes(sentinel)),
      toolRecord: denied.tools.some((tool) => JSON.stringify(tool).includes(sentinel)),
    }
    expect(privateVisibility).toEqual({
      rawResult: false,
      observation: false,
      followingModel: false,
      anyModel: false,
      toolRecord: false,
    })
    expect(denied.tools.find((tool) => tool.tool === "session_read")?.status).toBe("failed")
    expect(denied.tools.find((tool) => tool.tool === "session_read")?.error).toMatch(
      /authoriz|denied|permission|access|private|not found/i,
    )
  } finally {
    producer = undefined
    unsubscribe?.()
    active = undefined
    service.interceptFrames(undefined)
    for (const replay of heldSync.splice(0)) await replay()
    await upstream.stop(true)
  }
}, 90_000)
