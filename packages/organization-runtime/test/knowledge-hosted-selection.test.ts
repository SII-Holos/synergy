import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { prepareHostedHome } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { openHostedRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { observeTaskFailure } from "./support/task-failure"
import { applySelection, publish } from "./support/knowledge"
import { ModelRequest, SkillEvidence, runtimeContext, modelResponse, waitKnowledgeTask } from "./support/knowledge-task"
import { activeKnowledge } from "../src/knowledge"

test("actual Hosted Sessions inherit their creators' collections once and isolate collaborator updates with stale CAS", async () => {
  await using service = await fixture({ connections: { heartbeatMs: 25 } })
  const ownerOptions = { headers: service.headers, throwOnError: true as const }
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Hosted knowledge collections", description: "" } },
      ownerOptions,
    )
  ).data
  const invite = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, ownerOptions)).data
  const password = "hosted collaborator integration password"
  const collaborator = (
    await service.client.orgInvites.consume(
      {
        orgInviteConsume: {
          token: invite.token,
          requestID: "hosted-knowledge-collaborator",
          loginName: "collaborator",
          displayName: "Collaborator",
          password,
        },
      },
      { throwOnError: true },
    )
  ).data
  const login = await service.client.orgAuth.login(
    { orgLoginInput: { loginName: "collaborator", password } },
    { throwOnError: true },
  )
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("The real collaborator login did not establish a session")
  const collaboratorHeaders = { cookie, "x-csrf-token": login.data.csrfToken }
  const collaboratorOptions = { headers: collaboratorHeaders, throwOnError: true as const }
  await service.client.orgProjects.member(
    {
      projectID: project.projectID,
      accountID: collaborator.accountID,
      orgProjectMemberChange: { expectedRevision: project.revision, role: "collaborator" },
    },
    ownerOptions,
  )
  const first = await publish(
    service,
    project.projectID,
    "---\nname: team-work\ndescription: Team work\n---\nCreator one selected version",
    0,
  )
  const second = await publish(
    service,
    project.projectID,
    "---\nname: team-work\ndescription: Team work\n---\nCreator two selected version",
    1,
  )
  const ownerApplied = await applySelection(service, {
    projectID: project.projectID,
    expectedRevision: 0,
    releases: [first.reference],
  })
  const collaboratorService = { client: service.client, headers: collaboratorHeaders }
  const collaboratorApplied = await applySelection(collaboratorService, {
    projectID: project.projectID,
    expectedRevision: 0,
    releases: [second.reference],
  })
  const home = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "knowledge-host" },
    origin: service.origin,
  })
  const ticket = (
    await service.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Knowledge host", publicKey: home.publicKey } },
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
    listen: { port, token: "c".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("The actual Hosted Runtime did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
    service.interceptFrames(undefined)
  }
  const create = async (headers: Record<string, string>, requestID: string) =>
    (
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
  const firstCreated = await create(service.headers, "first-hosted-knowledge-session")
  const secondCreated = await create(collaboratorHeaders, "second-hosted-knowledge-session")
  const firstSessionID = firstCreated.effect.sessionID,
    secondSessionID = secondCreated.effect.sessionID
  const nativeFirst = await runtime.run(() => Session.get(firstSessionID))
  const nativeSecond = await runtime.run(() => Session.get(secondSessionID))
  expect(nativeFirst.organization).toMatchObject({
    creatorID: service.identity.accountID,
    driverRuntimeID: registration.runtimeID,
    projectID: project.projectID,
  })
  expect(nativeSecond.organization).toMatchObject({
    creatorID: collaborator.accountID,
    driverRuntimeID: registration.runtimeID,
    projectID: project.projectID,
  })
  const page = async (sessionID: string, headers: Record<string, string>) =>
    (await service.client.orgKnowledge.sessionSelectionPage({ sessionID, limit: 100 }, { headers, throwOnError: true }))
      .data
  const initialFirst = await page(firstSessionID, service.headers)
  const initialSecond = await page(secondSessionID, collaboratorHeaders)
  expect(initialFirst).toMatchObject({
    selection: { revision: 0, releaseCount: 1, updatedBy: service.identity.accountID },
    items: [first.reference],
  })
  expect(initialSecond).toMatchObject({
    selection: { revision: 0, releaseCount: 1, updatedBy: collaborator.accountID },
    items: [second.reference],
  })
  expect(initialFirst.cursor).toBeUndefined()
  expect(initialSecond.cursor).toBeUndefined()
  await applySelection(service, {
    projectID: project.projectID,
    expectedRevision: ownerApplied.revision,
    releases: [second.reference],
  })
  await applySelection(collaboratorService, {
    projectID: project.projectID,
    expectedRevision: collaboratorApplied.revision,
    releases: [first.reference],
  })
  expect(await page(firstSessionID, service.headers)).toEqual(initialFirst)
  expect(await page(secondSessionID, collaboratorHeaders)).toEqual(initialSecond)
  const requests: Array<z.infer<typeof ModelRequest>> = []
  let conversationStarted: (() => void) | undefined
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = ModelRequest.parse(await request.json())
      requests.push(input)
      if (!runtimeContext(input)) return modelResponse(requests.length)
      conversationStarted?.()
      const loaded = input.messages.some((message) => message.role === "tool")
      return modelResponse(requests.length, loaded ? undefined : { name: "skill", input: { name: "team-work" } })
    },
  })
  try {
    const model = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Hosted knowledge model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: new URL("/v1", upstream.url).href,
              model: { id: "knowledge-model", name: "Knowledge", limit: { context: 128000, output: 4096 } },
            },
            credential: { kind: "bearer", value: "hosted-knowledge-model-key" },
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
    for (const selected of [
      {
        sessionID: firstSessionID,
        headers: service.headers,
        expected: first.reference,
        text: "Creator one selected version",
      },
      {
        sessionID: secondSessionID,
        headers: collaboratorHeaders,
        expected: second.reference,
        text: "Creator two selected version",
      },
    ]) {
      const options = { headers: selected.headers, throwOnError: true as const }
      const manifestHash = createHash("sha256")
        .update(JSON.stringify([selected.expected]))
        .digest("hex")
      await service.client.orgSessionResources.set(
        {
          sessionID: selected.sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [],
              infrastructure: { workspace: null, environment: null },
            },
          },
        },
        options,
      )
      const firstRequest = Promise.withResolvers<void>()
      conversationStarted = () => firstRequest.resolve()
      const beforeRequests = requests.length
      const accepted = (
        await service.client.orgCommands.input(
          {
            sessionID: selected.sessionID,
            orgCommandInputRequest: {
              schemaVersion: 1,
              orgID: service.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              sessionID: selected.sessionID,
              requestID: `load-hosted-knowledge-${selected.expected.version}`,
              input: {
                operation: "input",
                mode: "task",
                parts: [{ type: "text", text: "Load the selected team-work Skill and finish." }],
              },
            },
          },
          options,
        )
      ).data
      const firstRequestTimer = setTimeout(
        () => firstRequest.reject(new Error("The actual Hosted model did not start")),
        4000,
      )
      try {
        await firstRequest.promise
      } catch (error) {
        await observeTaskFailure({
          runtime,
          accepted,
          stage: "hosted-model-start",
          upstreamCalls: requests.length - beforeRequests,
          contextCalls: requests.slice(beforeRequests).filter((request) => runtimeContext(request) !== undefined)
            .length,
        })
        throw error
      } finally {
        clearTimeout(firstRequestTimer)
        conversationStarted = undefined
      }
      const { owner, rootID } = await waitKnowledgeTask(runtime, accepted, () => requests.length - beforeRequests)
      const observed = requests.slice(beforeRequests)
      const conversation = observed.filter((request) => runtimeContext(request) !== undefined)
      expect(conversation).toHaveLength(2)
      for (const request of conversation)
        expect(runtimeContext(request)).toContain(
          `itemID=team version=${selected.expected.version} manifestHash=${selected.expected.manifestHash}`,
        )
      await runtime.run(async () => {
        const calls = await RolloutLedger.calls(owner, rootID)
        expect(calls).toHaveLength(observed.length)
        expect(calls.every((call) => call.status === "completed" && call.transportCaptured)).toBe(true)
        const main = calls.filter((call) => call.usageRole === "conversation")
        expect(main).toHaveLength(2)
        expect(
          main.every(
            (call) =>
              call.purpose === PrimaryAgentIdentity.names.general &&
              call.status === "completed" &&
              call.transportCaptured,
          ),
        ).toBe(true)
        expect(calls.filter((call) => call.usageRole !== "conversation")).toMatchObject([
          { purpose: "title", usageRole: "auxiliary", status: "completed" },
        ])
        const tools = await RolloutLedger.tools(owner, rootID)
        expect(tools).toHaveLength(1)
        const tool = tools[0]
        if (!tool?.rawResult) throw new Error("The actual Hosted Skill did not retain its original provenance")
        expect(tool).toMatchObject({ tool: "skill", status: "completed" })
        const chunks: Uint8Array[] = []
        for await (const chunk of RolloutArtifact.read(owner, tool.rawResult.id)) chunks.push(chunk)
        const evidence = SkillEvidence.parse(JSON.parse(Buffer.concat(chunks).toString()))
        expect(evidence.provenance).toEqual(selected.expected)
        expect(evidence.content.trim()).toBe(selected.text)
        expect(evidence.sha256).toBe(createHash("sha256").update(evidence.content).digest("hex"))
        expect((await activeKnowledge(selected.sessionID))?.selection.manifestHash).toBe(manifestHash)
      })
      expect((await service.client.orgKnowledge.status({ sessionID: selected.sessionID }, options)).data).toMatchObject(
        {
          state: "active",
          desired: { manifestHash },
          activated: { manifestHash },
        },
      )
    }
  } finally {
    conversationStarted = undefined
    await upstream.stop(true)
  }
  expect(await page(firstSessionID, service.headers)).toEqual(initialFirst)
  expect(await page(secondSessionID, collaboratorHeaders)).toEqual(initialSecond)
  await service.client.orgSessions.share(
    { sessionID: firstSessionID, orgShareChange: { expectedShareGeneration: 0 } },
    ownerOptions,
  )
  const stage = async (headers: Record<string, string>, requestID: string, reference: Knowledge.Reference) => {
    const options = { headers, throwOnError: true as const }
    const update = (
      await service.client.orgKnowledge.beginSelectionUpdate(
        {
          requestID,
          target: { kind: "session", sessionID: firstSessionID },
          expectedRevision: initialFirst.selection.revision,
        },
        options,
      )
    ).data
    await service.client.orgKnowledge.patchSelectionUpdate(
      { updateID: update.updateID, sequence: 0, changes: [{ itemID: reference.itemID, reference }] },
      options,
    )
    return update
  }
  const stale = await stage(service.headers, "owner-stale-session-selection", first.reference)
  const winner = await stage(collaboratorHeaders, "collaborator-session-selection", second.reference)
  const committed = (
    await service.client.orgKnowledge.commitSelectionUpdate(
      { updateID: winner.updateID, expectedSequence: 1 },
      collaboratorOptions,
    )
  ).data
  expect(committed).toMatchObject({ revision: initialFirst.selection.revision + 1, updatedBy: collaborator.accountID })
  const rejected = await service.client.orgKnowledge.commitSelectionUpdate(
    { updateID: stale.updateID, expectedSequence: 1 },
    { headers: service.headers, throwOnError: false },
  )
  expect(rejected.response.status).toBe(409)
  expect(rejected.error).toMatchObject({ code: "REVISION_CONFLICT" })
  expect(await page(firstSessionID, collaboratorHeaders)).toMatchObject({
    selection: committed,
    items: [second.reference],
  })
  expect(await page(secondSessionID, collaboratorHeaders)).toEqual(initialSecond)
  expect(
    (await service.client.orgKnowledge.appliedPage({ projectID: project.projectID }, ownerOptions)).data.items,
  ).toEqual([second.reference])
  expect(
    (await service.client.orgKnowledge.appliedPage({ projectID: project.projectID }, collaboratorOptions)).data.items,
  ).toEqual([first.reference])
  expect((await runtime.run(() => Session.get(firstSessionID))).organization).toEqual(nativeFirst.organization)
  expect((await runtime.run(() => Session.get(secondSessionID))).organization).toEqual(nativeSecond.organization)
})
