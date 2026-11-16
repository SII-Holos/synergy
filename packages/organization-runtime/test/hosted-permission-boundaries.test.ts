import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationInteractionProtocol as Interaction,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { prepareHostedHome } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { openHostedRuntime } from "../src/runtime"
import { OrganizationCommandRecords } from "../src/command-records"
import { OrganizationExecutionLeases } from "../src/execution-leases"
import { OrganizationIntakePath } from "../src/storage/path"
import { fixture } from "./support/organization"
import { ModelRequest, modelResponse, runtimeContext, waitKnowledgeTask } from "./support/knowledge-task"
import { observeTaskFailure } from "./support/task-failure"

const ObservedModelRequest = ModelRequest.extend({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
})
test("actual Hosted questions retain private waiting and shared collaboration after the creator leaves", async () => {
  await using service = await fixture({ connections: { heartbeatMs: 25 } })
  const ownerOptions = { headers: service.headers, throwOnError: true as const }
  const member = async (name: string) => {
    const invite = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, ownerOptions)).data
    const password = `hosted ${name} confirmation integration password`
    const account = (
      await service.client.orgInvites.consume(
        {
          orgInviteConsume: {
            token: invite.token,
            requestID: `hosted-question-${name}`,
            loginName: name,
            displayName: name,
            password,
          },
        },
        { throwOnError: true },
      )
    ).data
    const login = await service.client.orgAuth.login(
      { orgLoginInput: { loginName: name, password } },
      { throwOnError: true },
    )
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error("The real Hosted participant login did not establish a session")
    return { account, headers: { cookie, "x-csrf-token": login.data.csrfToken } }
  }
  const creator = await member("creator")
  const collaborator = await member("collaborator")
  const creatorOptions = { headers: creator.headers, throwOnError: true as const }
  const collaboratorOptions = { headers: collaborator.headers, throwOnError: true as const }
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Hosted confirmation lifetime", description: "" } },
      ownerOptions,
    )
  ).data
  let projectRevision = project.revision
  for (const account of [creator.account, collaborator.account]) {
    await service.client.orgProjects.member(
      {
        projectID: project.projectID,
        accountID: account.accountID,
        orgProjectMemberChange: { expectedRevision: projectRevision, role: "collaborator" },
      },
      ownerOptions,
    )
    projectRevision = (await service.client.orgProjects.get({ projectID: project.projectID }, ownerOptions)).data
      .revision
  }
  const requests: Array<{ subject: string; request: z.infer<typeof ObservedModelRequest> }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = ObservedModelRequest.parse(await request.json())
      requests.push({ subject: new URL(request.url).pathname.split("/")[1] ?? "", request: input })
      if (!runtimeContext(input)) return modelResponse(requests.length)
      const answered = input.messages.some((message) => message.role === "tool")
      return modelResponse(
        requests.length,
        answered
          ? undefined
          : {
              name: "question",
              input: {
                questions: [
                  {
                    question: "Approve this original Hosted work?",
                    header: "Work",
                    options: [{ label: "Proceed", description: "Finish this accepted work" }],
                  },
                ],
              },
            },
      )
    },
  })
  try {
    const home = await prepareHostedHome({
      baseDirectory: path.join(service.root, "hosted"),
      identity: { orgID: service.identity.orgID, hostID: "confirmation-host" },
      origin: service.origin,
    })
    const ticket = (
      await service.client.orgRuntime.registerHosted(
        { orgHostedRuntimeRegistration: { name: "Confirmation host", publicKey: home.publicKey } },
        ownerOptions,
      )
    ).data
    const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
    const online = Promise.withResolvers<void>()
    const connectionStarted = performance.now()
    const wire = { handshakes: 0, heartbeats: 0, frames: 0, epoch: 0, sequence: 0, heartbeatAt: 0, closes: 0 }
    let lastClose:
      | {
          code: number
          epoch: number
          pendingFrames: number
          pendingBytes: number
          leaseRemainingMs: number
          elapsedMs: number
          heartbeatAgeMs: number
        }
      | undefined
    service.observeClose((value) => {
      wire.closes++
      lastClose = {
        code: value.code,
        epoch: value.epoch,
        pendingFrames: value.pendingFrames,
        pendingBytes: value.pendingBytes,
        leaseRemainingMs: value.leaseRemainingMs,
        elapsedMs: Math.round(performance.now() - connectionStarted),
        heartbeatAgeMs: wire.heartbeatAt ? Math.round(performance.now() - wire.heartbeatAt) : -1,
      }
    })
    service.interceptFrames((_socket, raw) => {
      const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
      wire.frames++
      if (frame.type === "handshake") wire.handshakes++
      if (frame.type === "heartbeat") {
        wire.heartbeats++
        wire.epoch = frame.connectionEpoch
        wire.sequence = frame.sequence
        wire.heartbeatAt = performance.now()
        online.resolve()
      }
      return false
    })
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port
    if (!port) throw new Error("The isolated Hosted listener did not reserve a port")
    await probe.stop(true)
    const runtime = await openHostedRuntime({
      home: home.home,
      identity: home.identity,
      ca: service.ca,
      listen: { port, token: "d".repeat(64) },
    })
    try {
      const onlineTimer = setTimeout(() => online.reject(new Error("The actual Hosted Runtime did not connect")), 3000)
      try {
        await online.promise
      } finally {
        clearTimeout(onlineTimer)
      }
      const target = {
        schemaVersion: 1 as const,
        orgID: service.identity.orgID,
        projectID: project.projectID,
        runtimeID: registration.runtimeID,
      }
      const sessions = []
      for (const subject of ["private", "shared"]) {
        const created = (
          await service.client.orgSessions.create(
            {
              orgCommandCreateRequest: {
                ...target,
                requestID: `create-${subject}-question`,
                creation: { operation: "create", title: `${subject} Hosted question` },
              },
            },
            creatorOptions,
          )
        ).data
        const sessionID = created.effect.sessionID
        const model = (
          await service.client.orgResources.create(
            {
              orgResourceCreate: {
                name: `${subject} Hosted model`,
                scope: { kind: "organization" },
                configuration: {
                  protocol: "openai-compatible",
                  endpoint: new URL(`/${subject}/v1`, upstream.url).href,
                  model: { id: "knowledge-model", name: "Confirmation", limit: { context: 128000, output: 4096 } },
                },
                credential: { kind: "bearer", value: "hosted-confirmation-model-key" },
              },
            },
            ownerOptions,
          )
        ).data
        await service.client.orgResourceGrants.set(
          {
            resourceID: model.resourceID,
            kind: "account",
            subjectID: creator.account.accountID,
            orgResourceGrantChange: { expectedRevision: 0, enabled: true },
          },
          ownerOptions,
        )
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
          creatorOptions,
        )
        sessions.push({ subject, sessionID })
      }
      const privateSession = sessions.find((session) => session.subject === "private")
      const sharedSession = sessions.find((session) => session.subject === "shared")
      if (!privateSession || !sharedSession) throw new Error("Both actual Hosted Sessions must exist")
      await service.client.orgSessions.share(
        { sessionID: sharedSession.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
        creatorOptions,
      )
      const input = async (sessionID: string, headers: Record<string, string>, requestID: string) =>
        (
          await service.client.orgCommands.input(
            {
              sessionID,
              orgCommandInputRequest: {
                ...target,
                sessionID,
                requestID,
                input: { operation: "input", mode: "task", parts: [{ type: "text", text: requestID }] },
              },
            },
            { headers, throwOnError: true },
          )
        ).data
      const question = async (sessionID: string, requestID: string) => {
        type Ready = { kind: "asked"; requestID: string } | { kind: "failed"; error: unknown } | { kind: "completed" }
        const ready = Promise.withResolvers<Ready>()
        let accepted: Command.InputAccepted | undefined
        const failure: { current?: { error: unknown } } = {}
        const fail = (error: unknown) => {
          failure.current ??= { error }
          ready.resolve({ kind: "failed", error: failure.current.error })
        }
        const throwFailure = () => {
          if (failure.current) throw failure.current.error
        }
        const before = requests.length
        const unsubscribe = await runtime.run(() => [
          Bus.subscribeGlobal(Question.Event.Asked, (event) => {
            if (event.properties.sessionID === sessionID)
              ready.resolve({ kind: "asked", requestID: event.properties.id })
          }),
          Bus.subscribeGlobal(MessageV2.Event.Updated, (event) => {
            const info = event.properties.info
            if (info.sessionID !== sessionID || info.role !== "assistant" || !info.error) return
            if (accepted && info.rootID !== accepted.effect.messageID) return
            fail(info.error)
          }),
          Bus.subscribeGlobal(SessionEvent.Error, (event) => {
            if (event.properties.sessionID === sessionID && event.properties.error !== undefined)
              fail(event.properties.error)
          }),
          Bus.subscribeGlobal(SessionEvent.RootCompleted, (event) => {
            if (
              event.properties.sessionID === sessionID &&
              (!accepted || event.properties.rootID === accepted.effect.messageID)
            )
              ready.resolve({ kind: "completed" })
          }),
        ])
        let reachedAsked = false
        try {
          accepted = await input(sessionID, creator.headers, requestID)
          const observed = await ready.promise
          reachedAsked = observed.kind === "asked"
          throwFailure()
          if (observed.kind === "failed") throw observed.error
          if (observed.kind === "completed") throw new Error("The original Hosted task completed without its Question")
          const page = (
            await service.client.orgSessionInteractions.list(
              { sessionID, orgInteractionQuery: { operation: "pending", rootSessionID: sessionID, limit: 32 } },
              creatorOptions,
            )
          ).data
          throwFailure()
          if (page.operation !== "pending") throw new Error("The original Hosted pending interaction page is required")
          const pending = page.items.find(
            (entry): entry is Extract<Interaction.Pending, { kind: "question" }> =>
              entry.kind === "question" && entry.requestID === observed.requestID,
          )
          if (!pending)
            throw new Error("The original Asked Question is absent from its actual pending interaction page")
          return { accepted, pending }
        } catch (error) {
          console.error("HOSTED_QUESTION_CONNECTION", {
            observedAt: Date.now(),
            elapsedMs: Math.round(performance.now() - connectionStarted),
            reachedAsked,
            inputAccepted: accepted !== undefined,
            upstreamCalls: requests.length - before,
            handshakes: wire.handshakes,
            heartbeats: wire.heartbeats,
            frames: wire.frames,
            epoch: wire.epoch,
            sequence: wire.sequence,
            heartbeatAgeMs: wire.heartbeatAt ? Math.round(performance.now() - wire.heartbeatAt) : -1,
            closes: wire.closes,
            lastClose,
          })
          if (accepted)
            await observeTaskFailure({
              runtime,
              accepted,
              stage: "hosted-model-start",
              upstreamCalls: requests.length - before,
            })
          throw error
        } finally {
          for (const stop of unsubscribe) stop()
        }
      }
      const { accepted: privateInput, pending: privateQuestion } = await question(
        privateSession.sessionID,
        "private-original-input",
      )
      const { accepted: sharedInput, pending: sharedQuestion } = await question(
        sharedSession.sessionID,
        "shared-original-input",
      )
      expect(privateQuestion.tool).toBeDefined()
      expect(sharedQuestion.tool).toBeDefined()
      const reply = (sessionID: string, requestID: string, questionID: string): Command.DecisionRequest => ({
        ...target,
        sessionID,
        requestID,
        decision: {
          operation: "decision",
          kind: "question",
          requestID: questionID,
          reply: "answer",
          answers: [["Proceed"]],
        },
      })
      const accounts = (await service.client.orgAccounts.list({ limit: 100 }, ownerOptions)).data
      const currentCreator = accounts.items.find((account) => account.accountID === creator.account.accountID)
      if (!currentCreator) throw new Error("The actual creator account disappeared before its explicit removal")
      await service.client.orgAccounts.update(
        {
          accountID: currentCreator.accountID,
          orgAccountChange: { expectedRevision: currentCreator.revision, state: "removed" },
        },
        ownerOptions,
      )
      for (const selected of [
        { sessionID: privateSession.sessionID, pending: privateQuestion },
        { sessionID: sharedSession.sessionID, pending: sharedQuestion },
      ]) {
        const response = await service.client.orgSessionInteractions.reply(
          {
            sessionID: selected.sessionID,
            orgCommandDecisionRequest: reply(
              selected.sessionID,
              `removed-${selected.sessionID}`,
              selected.pending.requestID,
            ),
          },
          { headers: creator.headers, throwOnError: false },
        )
        expect(response.error).toMatchObject({ code: "AUTHENTICATION_REQUIRED" })
      }
      const privateDenied = await service.client.orgSessionInteractions.reply(
        {
          sessionID: privateSession.sessionID,
          orgCommandDecisionRequest: reply(
            privateSession.sessionID,
            "administrator-private-answer",
            privateQuestion.requestID,
          ),
        },
        { headers: service.headers, throwOnError: false },
      )
      expect(privateDenied.error).toMatchObject({ code: "NOT_FOUND" })
      const privateRead = await service.client.orgSessions.get(
        { sessionID: privateSession.sessionID },
        { headers: service.headers, throwOnError: false },
      )
      expect(privateRead.error).toMatchObject({ code: "NOT_FOUND" })
      const privateContinue = await service.client.orgCommands.control(
        {
          sessionID: privateSession.sessionID,
          orgCommandControlRequest: {
            ...target,
            sessionID: privateSession.sessionID,
            requestID: "administrator-private-continue",
            control: { operation: "continue", pausedSince: 0, controlVersion: 0 },
          },
        },
        { headers: service.headers, throwOnError: false },
      )
      expect(privateContinue.error).toMatchObject({ code: "NOT_FOUND" })
      const removedContinue = await service.client.orgCommands.control(
        {
          sessionID: sharedSession.sessionID,
          orgCommandControlRequest: {
            ...target,
            sessionID: sharedSession.sessionID,
            requestID: "removed-creator-continue",
            control: { operation: "continue", pausedSince: 0, controlVersion: 0 },
          },
        },
        { headers: creator.headers, throwOnError: false },
      )
      expect(removedContinue.error).toMatchObject({ code: "AUTHENTICATION_REQUIRED" })
      const answered = (
        await service.client.orgSessionInteractions.reply(
          {
            sessionID: sharedSession.sessionID,
            orgCommandDecisionRequest: reply(
              sharedSession.sessionID,
              "collaborator-shared-answer",
              sharedQuestion.requestID,
            ),
          },
          collaboratorOptions,
        )
      ).data
      expect(answered.effect).toMatchObject({
        kind: "decision",
        requestID: sharedQuestion.requestID,
        decision: {
          status: "resolved",
          winner: {
            actor: { subjectID: collaborator.account.accountID },
            outcome: { kind: "question", reply: "answer" },
          },
        },
      })
      await waitKnowledgeTask(
        runtime,
        sharedInput,
        () => requests.filter((request) => request.subject === "shared").length,
      )
      const beforeNextInput = requests.filter((request) => request.subject === "shared").length
      const next = await input(sharedSession.sessionID, collaborator.headers, "collaborator-after-removal")
      expect(next.permit.actor.subjectID).toBe(collaborator.account.accountID)
      await waitKnowledgeTask(
        runtime,
        next,
        () => requests.filter((request) => request.subject === "shared").length - beforeNextInput,
      )
      await runtime.run(async () => {
        const sharedInfo = await Session.get(sharedSession.sessionID)
        expect(sharedInfo.organization?.creatorID).toBe(creator.account.accountID)
        const original = await MessageV2.get({
          sessionID: sharedSession.sessionID,
          messageID: sharedInput.effect.messageID,
        })
        const later = await MessageV2.get({ sessionID: sharedSession.sessionID, messageID: next.effect.messageID })
        expect(original.info.actor?.subjectID).toBe(creator.account.accountID)
        expect(later.info.actor?.subjectID).toBe(collaborator.account.accountID)
        const privateInfo = await Session.get(privateSession.sessionID)
        await ScopeContext.provide({
          scope: privateInfo.scope,
          workspace: null,
          fn: async () => {
            expect(await Question.hasPending({ sessionID: privateInfo.id, requestID: privateQuestion.requestID })).toBe(
              true,
            )
          },
        })
        expect(
          (
            await RolloutLedger.getRun(
              { kind: "session", scopeID: project.projectID, sessionID: privateInfo.id },
              privateInput.effect.messageID,
            )
          ).status,
        ).toBe("running")
        const pending = await OrganizationExecutionLeases.page(registration.runtimeID, {
          target: { sessionID: privateInfo.id, rootID: privateInput.effect.messageID },
        })
        expect(pending.items.length).toBeGreaterThan(0)
        expect(
          pending.items.every(
            (entry) => entry.authority.input.subjectID === creator.account.accountID && entry.state === "pending",
          ),
        ).toBe(true)
      })
      const completedDeadline = Date.now() + 3000
      const completed = await runtime.run(async () => {
        for (;;) {
          const [raw] = await Storage.readMany([
            OrganizationIntakePath.release(
              sharedInput.permit.orgID,
              sharedInput.permit.actor.subjectID,
              sharedInput.permit.requestID,
            ),
          ])
          const release = OrganizationCommandRecords.Release.parse(raw)
          if (release.state === "released") return release
          if (Date.now() >= completedDeadline)
            throw new Error("The naturally completed shared work did not release its original retained grant")
          await Bun.sleep(25)
        }
      })
      expect(completed.receipt).toMatchObject({
        outcome: "completed",
        rootID: sharedInput.effect.messageID,
        grantID: sharedInput.permit.provisionalGrantID,
      })
      await runtime.close()
      const closedRequestCount = requests.length
      await using cold = await openHostedRuntime({ home: home.home, identity: home.identity, ca: service.ca })
      const interrupted = await cold.run(async () => {
        const info = await Session.get(privateSession.sessionID)
        const run = await RolloutLedger.getRun(
          { kind: "session", scopeID: project.projectID, sessionID: info.id },
          privateInput.effect.messageID,
        )
        const [raw] = await Storage.readMany([
          OrganizationIntakePath.release(
            privateInput.permit.orgID,
            privateInput.permit.actor.subjectID,
            privateInput.permit.requestID,
          ),
        ])
        if (raw === undefined) throw new Error("The interrupted original Hosted input lost its release record")
        const release = OrganizationCommandRecords.Release.parse(raw)
        const pending = []
        let after: string | undefined
        do {
          const page = await OrganizationExecutionLeases.page(registration.runtimeID, {
            after,
            target: { sessionID: info.id, rootID: privateInput.effect.messageID },
          })
          pending.push(...page.items)
          after = page.cursor
        } while (after)
        return { info, run, release, pending }
      })
      expect(interrupted.info.paused).toMatchObject({ reason: "interrupted" })
      expect(interrupted.run.status).toBe("interrupted")
      expect(interrupted.release).toMatchObject({
        orgID: privateInput.permit.orgID,
        subjectID: creator.account.accountID,
        sessionID: privateSession.sessionID,
        rootID: privateInput.effect.messageID,
        runtimeID: registration.runtimeID,
        bindingEpoch: privateInput.permit.bindingEpoch,
        grantID: privateInput.permit.provisionalGrantID,
        actor: privateInput.permit.actor,
        requestID: privateInput.permit.requestID,
      })
      expect(interrupted.release.state).toBe("pending")
      expect(interrupted.release.receipt).toBeUndefined()
      expect(interrupted.pending.length).toBeGreaterThan(0)
      expect(requests).toHaveLength(closedRequestCount)
      await cold.close()
      const inspected = Promise.withResolvers<Execution.Inspection>()
      service.interceptHTTP(async (request) => {
        if (!new URL(request.url).pathname.endsWith("/execution/retention")) return
        const response = await service.service.fetch(request)
        if (response.ok) {
          const result = Execution.Inspection.safeParse(await response.clone().json())
          if (result.success && result.data.rootID === privateInput.effect.messageID) inspected.resolve(result.data)
        }
        return response
      })
      await using reconnected = await openHostedRuntime({
        home: home.home,
        identity: home.identity,
        ca: service.ca,
        listen: { port, token: "d".repeat(64) },
      })
      const inspectionTimeout = setTimeout(
        () =>
          inspected.reject(
            new Error("The original Hosted Runtime did not inspect its retained grant after reconnecting"),
          ),
        3000,
      )
      let inspection: Execution.Inspection
      try {
        inspection = await inspected.promise
      } finally {
        clearTimeout(inspectionTimeout)
      }
      expect(inspection.state).toBe("known")
      if (inspection.state !== "known" || inspection.grant.state !== "bound")
        throw new Error("The interrupted original input lost its retained resource generation")
      expect(inspection.grant.retention.state).toBe("held")
      expect(inspection.release).toBeUndefined()
      expect(inspection).toMatchObject({
        runtimeID: registration.runtimeID,
        sessionID: privateSession.sessionID,
        rootID: privateInput.effect.messageID,
        bindingEpoch: privateInput.permit.bindingEpoch,
        originGrantID: privateInput.permit.provisionalGrantID,
      })
      const retained = await reconnected.run(async () => {
        const info = await Session.get(privateSession.sessionID)
        const run = await RolloutLedger.getRun(
          { kind: "session", scopeID: project.projectID, sessionID: info.id },
          privateInput.effect.messageID,
        )
        const [raw] = await Storage.readMany([
          OrganizationIntakePath.release(
            privateInput.permit.orgID,
            privateInput.permit.actor.subjectID,
            privateInput.permit.requestID,
          ),
        ])
        const release = OrganizationCommandRecords.Release.parse(raw)
        const page = await OrganizationExecutionLeases.page(registration.runtimeID, {
          target: { sessionID: privateSession.sessionID, rootID: privateInput.effect.messageID },
        })
        return { info, run, release, pending: page.items }
      })
      expect(retained.info.paused).toMatchObject({ reason: "interrupted" })
      expect(retained.run.status).toBe("interrupted")
      expect(retained.release).toEqual(interrupted.release)
      expect(retained.pending.length).toBeGreaterThan(0)
      expect(
        retained.pending.every(
          (entry) =>
            entry.state === "pending" &&
            entry.authority.rootID === privateInput.effect.messageID &&
            entry.authority.input.subjectID === creator.account.accountID,
        ),
      ).toBe(true)
      expect(requests).toHaveLength(closedRequestCount)
    } finally {
      service.interceptHTTP(undefined)
      service.interceptFrames(undefined)
      service.observeClose(undefined)
      await runtime.close()
    }
  } finally {
    await upstream.stop(true)
  }
}, 30000)
