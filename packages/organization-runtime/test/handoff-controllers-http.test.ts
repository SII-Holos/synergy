import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import {
  SessionTransferCore as Core,
  SessionTransferSource as NativeSource,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { registerWorkspace } from "@ericsanchezok/synergy-local-runtime/register-workspace"
import { fixture } from "./support/organization"
import {
  prepareMemberHome,
  prepareHostedHome,
  runtimeIdentityDigest,
  NativeHomeReaderContract,
  type RuntimeIdentity,
} from "../src/home"
import { enrollMemberRuntime, enrollHostedRuntime } from "../src/enrollment"
import { openMemberConnection } from "../src/connection"
import { createCommandIntake, readCommandControlVersion } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationHandoffSource as Source } from "../src/handoff-source"
import { OrganizationHandoffTarget as Target } from "../src/handoff-target"

async function unavailable(): Promise<never> {
  throw new Error("This fixture does not submit input or Continue")
}
const unused = () => ({
  create: unavailable,
  control: unavailable,
  input: unavailable,
  decision: unavailable,
  query: unavailable,
  skip: unavailable,
})
function execution(plan: Handoff.MachinePlan, fact: Handoff.Proof): Promise<Handoff.MachineExecution> {
  return Handoff.proofHash(fact).then((revision) =>
    Handoff.MachineExecution.parse({
      handoffID: plan.handoffID,
      requestID: plan.requestID,
      runtimeID: plan.runtimeID,
      operation: plan.operation,
      state: "complete",
      stage: fact.purpose,
      revision,
      requirements: [],
      facts: [fact],
    }),
  )
}

test.each([
  "cancel",
  "transfer",
  "unknown",
  "observer",
  "resource-cancel",
  "resource-cancel-retained",
  "resource-transfer",
  "resource-close-unknown",
] as const)(
  "generated HTTPS and actual enrolled machine Homes preserve %s without input replay",
  async (mode) => {
    const withResources = mode.startsWith("resource-")
    const wake = withResources ? spyOn(SessionManager, "scheduleWake").mockImplementation(() => {}) : undefined
    using restoreWake = {
      [Symbol.dispose]() {
        wake?.mockRestore()
      },
    }
    await using f = await fixture()
    let sourceIntake: ReturnType<typeof createCommandIntake> | undefined
    let targetIntake: ReturnType<typeof createCommandIntake> | undefined
    const member = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: f.identity,
      origin: f.origin,
    })
    const sourceRegistration = await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ticket: await f.ticket(member.identity.deviceID, member.publicKey),
      ca: f.ca,
    })
    const hosted = await prepareHostedHome({
      baseDirectory: path.join(f.root, "hosted"),
      identity: { orgID: f.identity.orgID, hostID: "controller-target" },
      origin: f.origin,
    })
    const ticket = (
      await f.client.orgRuntime.registerHosted(
        { orgHostedRuntimeRegistration: { name: "Controller target", publicKey: hosted.publicKey } },
        { headers: f.headers, throwOnError: true },
      )
    ).data
    const targetRegistration = await enrollHostedRuntime({
      home: hosted.home,
      identity: hosted.identity,
      ticket,
      ca: f.ca,
    })
    const coordinator = new WorkspaceCoordinator({ directory: path.join(f.root, "claims") })
    const register = (identity: RuntimeIdentity) => {
      HomeOwnership.select({
        owner: "organization-runtime",
        identity: runtimeIdentityDigest(identity),
        readerContract: NativeHomeReaderContract,
      })
      registerWorkspace(coordinator)
      Core.register()
      registerSessionSchema({ orgID: identity.orgID })
      registerOrganizationTransferOwner()
    }
    await using source = await testRuntime({ home: member.home, register: () => register(member.identity) })
    await using target = await testRuntime({ home: hosted.home, register: () => register(hosted.identity) })
    const sourceController = await source.run(() =>
      Source.create({ identity: member.identity, runtimeID: sourceRegistration.runtimeID }),
    )
    const sourceEntered = Promise.withResolvers<void>()
    const sourceResume = Promise.withResolvers<void>()
    const sourceFinished = Promise.withResolvers<void>()
    const targetEntered = Promise.withResolvers<void>()
    const targetResume = Promise.withResolvers<void>()
    const targetFinished = Promise.withResolvers<void>()
    let nativePreparations = 0
    const prepare = NativeSource.prepare
    const blocked =
      mode === "observer"
        ? spyOn(NativeSource, "prepare").mockImplementation(async (input) => {
            nativePreparations++
            return prepare({
              ...input,
              async beforeFreeze() {
                sourceEntered.resolve()
                await sourceResume.promise
                await input.beforeFreeze?.()
              },
            })
          })
        : undefined
    if (mode === "observer")
      f.interceptFrames((_socket, raw) => {
        const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
        if (frame.type === "receipt" && frame.reply.kind === "handoff") {
          if (frame.reply.result.operation === "prepare-source") sourceFinished.resolve()
          if (frame.reply.result.operation === "prepare-target") targetFinished.resolve()
        }
        return false
      })
    let preparations = 0
    let mappings = 0
    let sourceSignal: AbortSignal | undefined
    let targetSignal: AbortSignal | undefined
    const targetController = await target.run(() =>
      Target.create({ identity: hosted.identity, runtimeID: targetRegistration.runtimeID }),
    )
    await using sourceConnection = await openMemberConnection({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      buildVersion: "actual-source-controller",
      commands(connection, signal) {
        const intake = createCommandIntake({
          identity: connection.signingIdentity,
          runtimeID: connection.runtimeID,
          accountID: member.identity.accountID,
          connectionEpoch: connection.connectionEpoch,
          signal,
        })
        sourceIntake = intake
        return {
          create: (delivery) => source.run(() => intake.create(delivery)),
          input: (delivery) => source.run(() => intake.input(delivery)),
          control: (delivery, received) => source.run(() => intake.control(delivery, received)),
          decision: (delivery) => source.run(() => intake.decision(delivery)),
          query: (delivery) => source.run(() => intake.query(delivery)),
          skip: (delivery) => source.run(() => intake.skip(delivery)),
        }
      },
      handoff: (authorization, connection, signal, resources) =>
        source.run(async () => {
          const input = { authorization, connection, signal, resources }
          sourceSignal = signal
          const plan = authorization.plan
          if (plan.operation === "prepare-source") preparations++
          if (plan.operation === "object")
            return Handoff.MachineExecution.parse({
              handoffID: plan.handoffID,
              requestID: plan.requestID,
              runtimeID: plan.runtimeID,
              operation: plan.operation,
              state: "complete",
              stage: "source-frozen",
              revision: plan.manifestHash,
              requirements: [],
              facts: [],
              object: await sourceController.range(input),
            })
          if (plan.operation === "inspect-source") return sourceController.inspect(input)
          const fact =
            plan.operation === "prepare-source"
              ? await sourceController.prepare(input)
              : plan.operation === "cancel-source"
                ? await sourceController.cancel(input)
                : plan.operation === "surrender-source"
                  ? await sourceController.surrender(input)
                  : await unavailable()
          return execution(plan, fact)
        }),
    })
    await using targetConnection = await openMemberConnection({
      home: hosted.home,
      identity: hosted.identity,
      ca: f.ca,
      buildVersion: "actual-target-controller",
      commands(connection, signal) {
        const intake = createCommandIntake({
          identity: connection.signingIdentity,
          runtimeID: connection.runtimeID,
          connectionEpoch: connection.connectionEpoch,
          signal,
        })
        targetIntake = intake
        return {
          create: (delivery) => target.run(() => intake.create(delivery)),
          input: (delivery) => target.run(() => intake.input(delivery)),
          control: (delivery, received) => target.run(() => intake.control(delivery, received)),
          decision: (delivery) => target.run(() => intake.decision(delivery)),
          query: (delivery) => target.run(() => intake.query(delivery)),
          skip: (delivery) => target.run(() => intake.skip(delivery)),
        }
      },
      handoff: (authorization, connection, signal, resources) =>
        target.run(async () => {
          const input = {
            authorization,
            connection,
            signal,
            resources,
            mapping: async () => {
              mappings++
              if (mode === "observer") {
                targetEntered.resolve()
                await targetResume.promise
              }
              return { workspaceIDs: {}, environmentID: null }
            },
          }
          targetSignal = signal
          if (authorization.plan.operation === "inspect-target") return targetController.inspect(input)
          const fact =
            authorization.plan.operation === "prepare-target"
              ? await targetController.prepare(input)
              : authorization.plan.operation === "activate-target"
                ? await targetController.activate(input)
                : await unavailable()
          return execution(authorization.plan, fact)
        }),
    })
    try {
      const options = { headers: f.headers, throwOnError: true as const }
      const project = (
        await f.client.orgProjects.create(
          { orgProjectCreate: { name: "Controller project", description: "" } },
          options,
        )
      ).data
      const created = (
        await f.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              schemaVersion: 1,
              orgID: f.identity.orgID,
              projectID: project.projectID,
              runtimeID: sourceRegistration.runtimeID,
              requestID: "create-controller-session",
              creation: { operation: "create", title: "Retain this exact Session" },
            },
          },
          options,
        )
      ).data
      const sessionID = created.effect.sessionID
      let original: Command.InputAccepted | undefined
      let originalGrant: Execution.BoundGrant | undefined
      if (withResources) {
        const resource = (
          await f.client.orgResources.create(
            {
              orgResourceCreate: {
                name: "Continuation model",
                scope: { kind: "organization" },
                configuration: {
                  protocol: "openai-compatible",
                  endpoint: "https://provider.example/v1",
                  model: { id: "continuation-model", name: "Continuation", limit: { context: 8192, output: 1024 } },
                },
                credential: { kind: "bearer", value: "isolated-resource-key" },
              },
            },
            options,
          )
        ).data
        await f.client.orgResourceGrants.set(
          {
            resourceID: resource.resourceID,
            kind: "account",
            subjectID: f.identity.accountID,
            orgResourceGrantChange: { expectedRevision: 0, enabled: true },
          },
          options,
        )
        await f.client.orgSessionResources.set(
          {
            sessionID,
            orgSessionResourceChange: {
              expectedRevision: 0,
              selection: { modelResourceID: resource.resourceID, connectionResourceIDs: [] },
            },
          },
          options,
        )
        original = Command.InputAccepted.parse(
          (
            await f.client.orgCommands.input(
              {
                sessionID,
                orgCommandInputRequest: {
                  schemaVersion: 1,
                  orgID: f.identity.orgID,
                  projectID: project.projectID,
                  sessionID,
                  runtimeID: sourceRegistration.runtimeID,
                  requestID: "original-continuation-input",
                  input: {
                    operation: "input",
                    mode: "task",
                    parts: [{ type: "text", text: "Keep the original root and actor" }],
                  },
                },
              },
              options,
            )
          ).data,
        )
        const accepted = original
        const proof = await source.run(async () => {
          const session = await Session.get(sessionID)
          return ScopeContext.provide({
            scope: session.scope,
            workspace: null,
            fn: async () => {
              await Session.update(sessionID, (draft) => {
                draft.modelOverride = { providerID: "test", modelID: "test" }
              })
              expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
              await RolloutLedger.beginRun(RolloutLifecycle.owner(session), accepted.effect.messageID)
              return sourceIntake!.bindingProof(
                { subjectID: accepted.permit.actor.subjectID, requestID: accepted.permit.requestID },
                accepted.effect.messageID,
              )
            },
          })
        })
        originalGrant = await sourceConnection.resources.bind(proof)
        expect(originalGrant.retention).toEqual({ state: "held", generation: 1 })
      }
      async function resumeResources(
        current: typeof source,
        intake: ReturnType<typeof createCommandIntake>,
        connection: typeof sourceConnection,
        epoch: number,
      ) {
        const accepted = original!
        const lookup = { subjectID: accepted.permit.actor.subjectID, requestID: accepted.permit.requestID }
        const control = await current.run(async () => ({
          operation: "continue" as const,
          pausedSince: (await Session.get(sessionID)).paused!.since,
          controlVersion: await readCommandControlVersion(f.identity.orgID, sessionID),
        }))
        const continued = Command.ControlAccepted.parse(
          (
            await f.client.orgCommands.control(
              {
                sessionID,
                orgCommandControlRequest: {
                  schemaVersion: 1,
                  orgID: f.identity.orgID,
                  projectID: project.projectID,
                  sessionID,
                  runtimeID: connection.connected.runtimeID,
                  requestID: "explicit-post-handoff-control",
                  control,
                },
              },
              options,
            )
          ).data,
        )
        expect(continued.effect).toMatchObject({ operation: "continue", rootID: accepted.effect.messageID })
        const description = await current.run(() => intake.descriptionProof(lookup))
        expect(description.receipt.accepted).toEqual(accepted)
        expect(description.continuation?.receipt.accepted).toEqual(continued)
        const resources = await connection.resources.describe(description)
        expect(resources.grant).toMatchObject({
          runtimeID: connection.connected.runtimeID,
          bindingEpoch: epoch,
          actor: accepted.permit.actor,
          admissionID: accepted.permit.admissionID,
          attemptID: accepted.permit.attemptID,
          provenance: { originGrantID: originalGrant!.grantID, rootID: accepted.effect.messageID, control: continued },
        })
        expect(resources.grant.grantID).not.toBe(originalGrant!.grantID)
        const binding = await current.run(() => intake.bindingProof(lookup, accepted.effect.messageID))
        const bound = await connection.resources.bind(binding)
        expect(bound).toMatchObject({
          grantID: resources.grant.grantID,
          rootID: accepted.effect.messageID,
          retention: { state: "held", generation: 1 },
        })
        await current.run(async () => {
          const session = await Session.get(sessionID)
          expect(
            (await MessageV2.readInfo({ scopeID: session.scope.id, sessionID, messageID: accepted.effect.messageID }))
              .actor,
          ).toEqual(accepted.permit.actor)
          await ScopeContext.provide({
            scope: session.scope,
            workspace: null,
            fn: () => RolloutLedger.finishRun(RolloutLifecycle.owner(session), accepted.effect.messageID, "completed"),
          })
        })
        const release = Execution.ReleaseProof.parse({
          ...binding,
          purpose: "execution-resources-release",
          grantID: bound.grantID,
          rootID: bound.rootID,
          generation: bound.retention.generation,
          outcome: "completed",
        })
        expect(await connection.resources.release(release)).toMatchObject({
          grantID: bound.grantID,
          rootID: accepted.effect.messageID,
          generation: 1,
        })
        expect(await connection.resources.release(release)).toMatchObject({
          grantID: bound.grantID,
          outcome: "completed",
        })
        await expect(connection.resources.bind(binding)).rejects.toThrow()
      }
      const handoffID = "actual-controller-transfer"
      await f.client.orgHandoff.prepare(
        {
          sessionID,
          orgHandoffPrepare: {
            handoffID,
            targetRuntimeID: targetRegistration.runtimeID,
            expectedBindingEpoch: 1,
            expectedControlRevision: 0,
            mappingPlanRevision: 1,
          },
        },
        options,
      )
      const drive = async (operation: Handoff.Drive["operation"]) =>
        Handoff.MachineResult.parse(
          (
            await f.client.orgHandoff.drive(
              { handoffID, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
              options,
            )
          ).data,
        )
      let frozen: Handoff.MachineResult
      if (mode === "unknown") {
        const arrived = Promise.withResolvers<void>()
        f.interceptFrames((_socket, raw) => {
          const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
          if (
            frame.type === "receipt" &&
            frame.reply.kind === "handoff" &&
            frame.reply.result.operation === "prepare-source"
          ) {
            arrived.resolve()
            return true
          }
          return false
        })
        const signal = new AbortController()
        const unknown = f.client.orgHandoff.drive(
          { handoffID, orgHandoffDrive: { operation: "prepare-source", requestID: "source-response-lost" } },
          { ...options, signal: signal.signal },
        )
        void unknown.catch(() => {})
        await arrived.promise
        signal.abort(new Error("Stop observing the unknown source response"))
        await expect(unknown).rejects.toThrow()
        f.interceptFrames(undefined)
        frozen = await drive("inspect-source")
      } else if (mode === "observer") {
        const observer = new AbortController()
        const pending = f.client.orgHandoff.drive(
          { handoffID, orgHandoffDrive: { operation: "prepare-source", requestID: "short-source-observer" } },
          { ...options, signal: observer.signal },
        )
        void pending.catch(() => {})
        await sourceEntered.promise
        const deadline = setTimeout(() => observer.abort(new Error("Source observer deadline")), 20)
        try {
          await expect(pending).rejects.toThrow()
        } finally {
          clearTimeout(deadline)
        }
        expect(sourceSignal?.aborted).toBe(false)
        expect(await drive("inspect-source")).toMatchObject({ state: "working", facts: [] })
        sourceResume.resolve()
        await sourceFinished.promise
        frozen = await drive("inspect-source")
        expect(nativePreparations).toBe(1)
      } else frozen = await drive("prepare-source")
      expect(frozen.facts[0]?.proof).toMatchObject({ purpose: "source-frozen", drained: true, paused: true })
      expect(preparations).toBe(1)
      if (mode === "cancel" || mode === "resource-cancel-retained") {
        await f.client.orgHandoff.cancel({ handoffID, body: {} }, options)
        expect((await drive("cancel-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
        expect((await drive("inspect-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
        expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("cancelled")
        await source.run(async () => {
          expect((await Session.get(sessionID)).paused).toBeDefined()
        })
        await target.run(async () => {
          await expect(Session.get(sessionID)).rejects.toThrow()
        })
        if (withResources) await resumeResources(source, sourceIntake!, sourceConnection, 1)
        return
      }
      let prepared: Handoff.MachineResult
      if (mode === "observer") {
        const observer = new AbortController()
        const pending = f.client.orgHandoff.drive(
          { handoffID, orgHandoffDrive: { operation: "prepare-target", requestID: "short-target-observer" } },
          { ...options, signal: observer.signal },
        )
        void pending.catch(() => {})
        await targetEntered.promise
        const deadline = setTimeout(() => observer.abort(new Error("Target observer deadline")), 20)
        try {
          await expect(pending).rejects.toThrow()
        } finally {
          clearTimeout(deadline)
        }
        expect(targetSignal?.aborted).toBe(false)
        expect(await drive("inspect-target")).toMatchObject({ state: "working", stage: "preparing", facts: [] })
        targetResume.resolve()
        await targetFinished.promise
        prepared = await drive("inspect-target")
        expect(mappings).toBe(1)
      } else prepared = await drive("prepare-target")
      expect(prepared.facts[0]?.proof.purpose).toBe("target-prepared")
      await target.run(async () => {
        await expect(Session.get(sessionID)).rejects.toThrow()
      })
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("prepared")
      await f.client.orgHandoff.permit(
        { handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
        options,
      )
      if (mode === "resource-cancel") {
        const failSurrender = spyOn(NativeSource, "surrender").mockImplementationOnce(async () => {
          throw new Error("Stop after the real retention close")
        })
        try {
          await expect(drive("surrender-source")).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            outcome: "unknown",
          })
        } finally {
          failSurrender.mockRestore()
        }
        const retained = await sourceConnection.resources.retention(
          await source.run(() =>
            sourceIntake!.retentionProof({
              subjectID: original!.permit.actor.subjectID,
              requestID: original!.permit.requestID,
            }),
          ),
        )
        expect(retained).toMatchObject({
          grantID: originalGrant!.grantID,
          retention: { state: "handoff_closed", generation: 1 },
        })
        await f.client.orgHandoff.cancel({ handoffID, body: {} }, options)
        expect((await drive("cancel-source")).facts[0]?.proof.purpose).toBe("source-cancelled")
        expect((await source.run(() => Session.get(sessionID))).paused).toBeDefined()
        await resumeResources(source, sourceIntake!, sourceConnection, 1)
        return
      }
      if (mode === "resource-close-unknown") {
        let closed = 0
        f.interceptHTTP(async (request) => {
          if (!new URL(request.url).pathname.endsWith("/execution/handoff-close")) return
          closed++
          const committed = await f.service.fetch(request)
          expect(committed.status).toBe(200)
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "Lost committed closure reply",
              retryable: false,
              outcome: "unknown",
            },
            { status: 503 },
          )
        })
        await expect(drive("surrender-source")).rejects.toMatchObject({
          code: "SERVICE_UNAVAILABLE",
          outcome: "unknown",
        })
        f.interceptHTTP(undefined)
        expect(closed).toBe(1)
        expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("prepared")
      }
      expect((await drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
      expect((await drive("inspect-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
      expect((await f.client.orgHandoff.commit({ handoffID, body: {} }, options)).data.phase).toBe("committed")
      await f.client.orgHandoff.permit(
        { handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
        options,
      )
      expect((await drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
      expect((await drive("inspect-target")).facts[0]?.proof.purpose).toBe("target-activated")
      expect((await f.client.orgHandoff.get({ handoffID }, options)).data).toMatchObject({
        phase: "completed",
        currentDriver: targetRegistration.runtimeID,
        bindingEpoch: 2,
      })
      await target.run(async () => {
        expect(await Session.get(sessionID)).toMatchObject({
          id: sessionID,
          title: "Retain this exact Session",
          paused: expect.anything(),
          organization: {
            creatorID: f.identity.accountID,
            driverRuntimeID: targetRegistration.runtimeID,
            bindingEpoch: 2,
          },
        })
      })
      if (withResources) await resumeResources(target, targetIntake!, targetConnection, 2)
    } finally {
      sourceResume.resolve()
      targetResume.resolve()
      blocked?.mockRestore()
      await source.run(() => sourceController.close())
    }
  },
  15000,
)
