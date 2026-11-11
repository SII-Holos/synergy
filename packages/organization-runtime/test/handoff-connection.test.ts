import { expect, test } from "bun:test"
import path from "node:path"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import {
  SessionTransferCore as Core,
  SessionTransferEpochs as Epochs,
  SessionTransferSource as Source,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { fixture } from "./support/organization"
import { prepareMemberHome, prepareHostedHome } from "../src/home"
import { enrollMemberRuntime, enrollHostedRuntime } from "../src/enrollment"
import { openMemberConnection } from "../src/connection"
import { createCommandIntake } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationHandoffObjects as Objects } from "../src/handoff-objects"

async function unavailable(): Promise<never> {
  throw new Error("This transport fixture does not execute work")
}

test("generated HTTPS handoff dispatch reaches the verified native connection and reconciles its actual signed cancellation", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  const source = await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    ca: f.ca,
  })
  const hosted = await prepareHostedHome({
    baseDirectory: path.join(f.root, "hosted"),
    identity: { orgID: f.identity.orgID, hostID: "handoff-target" },
    origin: f.origin,
  })
  const ticket = (
    await f.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Handoff target", publicKey: hosted.publicKey } },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const target = await enrollHostedRuntime({ home: hosted.home, identity: hosted.identity, ticket, ca: f.ca })
  await using native = await testRuntime({
    register() {
      Core.register()
      registerSessionSchema()
      registerOrganizationTransferOwner()
    },
  })
  let called = 0
  let captured: Handoff.SignedMachinePlan | undefined
  const sourceWire = Promise.withResolvers<Parameters<NonNullable<Parameters<typeof f.interceptFrames>[0]>>[0]>()
  const invalid = Promise.withResolvers<Command.Reply>()
  f.interceptFrames((socket, raw) => {
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake" && frame.proof.handshake.runtimeID === source.runtimeID) sourceWire.resolve(socket)
    if (frame.type === "receipt" && frame.exchangeID === "invalid-service-plan") {
      invalid.resolve(frame.reply)
      return true
    }
    return false
  })
  await using connection = await openMemberConnection({
    home: member.home,
    identity: member.identity,
    ca: f.ca,
    buildVersion: "handoff-native-fixture",
    commands(current, signal) {
      return {
        create: (delivery) =>
          native.run(() =>
            createCommandIntake({
              identity: current.signingIdentity,
              runtimeID: current.runtimeID,
              accountID: member.identity.accountID,
              connectionEpoch: current.connectionEpoch,
              signal,
            }).create(delivery),
          ),
        control: unavailable,
        input: unavailable,
        decision: unavailable,
        query: unavailable,
        skip: unavailable,
      }
    },
    handoff: (authorization, current, signal) =>
      native.run(async () => {
        called++
        captured = authorization
        const plan = authorization.plan
        const binding = {
          sessionID: plan.sessionID,
          scopeID: plan.sourceBinding.projectID,
          handoffID: plan.handoffID,
          sourceID: plan.sourceRuntimeID,
          targetID: plan.targetRuntimeID,
          fromEpoch: plan.fromEpoch,
          toEpoch: plan.toEpoch,
        }
        const session = await Session.get(plan.sessionID)
        return ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: async () => {
            const intake = createCommandIntake({
              identity: current.signingIdentity,
              runtimeID: current.runtimeID,
              accountID: member.identity.accountID,
              connectionEpoch: current.connectionEpoch,
              signal,
            })
            const base = {
              handoffID: plan.handoffID,
              requestID: plan.requestID,
              runtimeID: plan.runtimeID,
              operation: plan.operation,
              revision: "a".repeat(64),
            }
            if (plan.operation === "prepare-source") {
              const objects = await Objects.open(
                { orgID: plan.orgID, deploymentIncarnation: plan.deploymentIncarnation, role: "source", binding },
                signal,
              )
              await Source.prepare({
                binding,
                store: objects.store,
                signal,
                verify: () => intake.barrier(plan.sessionID, plan.fromEpoch, plan.commandSeq).then(() => {}),
              })
              await objects.sealSource()
              return Handoff.MachineExecution.parse({
                ...base,
                state: "blocked",
                stage: "preparing",
                requirements: [
                  {
                    code: "physical_writer_proof",
                    label: "Physical writer proof has not been supplied",
                    recoverable: true,
                  },
                ],
                facts: [],
              })
            }
            if (plan.operation !== "cancel-source") throw new Error("Unexpected machine fixture operation")
            const frozen = await Source.status(binding)
            await Epochs.cancel(binding)
            return Handoff.MachineExecution.parse({
              ...base,
              state: "complete",
              stage: "source-cancelled",
              requirements: [],
              facts: [
                Handoff.Proof.parse({
                  schemaVersion: 1,
                  orgID: plan.orgID,
                  deploymentIncarnation: plan.deploymentIncarnation,
                  handoffID: plan.handoffID,
                  sessionID: plan.sessionID,
                  sourceRuntimeID: plan.sourceRuntimeID,
                  targetRuntimeID: plan.targetRuntimeID,
                  fromEpoch: plan.fromEpoch,
                  toEpoch: plan.toEpoch,
                  mappingPlanRevision: plan.mappingPlanRevision,
                  shareGeneration: plan.shareGeneration,
                  purpose: "source-cancelled",
                  manifestHash: frozen?.manifestHash ?? null,
                  gateCancelled: true,
                  paused: true,
                }),
              ],
            })
          },
        })
      }),
  })
  await using targetConnection = await openMemberConnection({
    home: hosted.home,
    identity: hosted.identity,
    ca: f.ca,
    buildVersion: "handoff-native-target",
    handoff: unavailable,
    commands() {
      return {
        create: unavailable,
        control: unavailable,
        input: unavailable,
        decision: unavailable,
        query: unavailable,
        skip: unavailable,
      }
    },
  })
  const project = (
    await f.client.orgProjects.create(
      { orgProjectCreate: { name: "Machine handoff", description: "" } },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const created = (
    await f.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: source.runtimeID,
          requestID: "machine-native-create",
          creation: { operation: "create", title: "Native handoff" },
        },
      },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const sessionID = created.effect.sessionID
  const handoffID = "native-connection-handoff"
  await f.client.orgHandoff.prepare(
    {
      sessionID,
      orgHandoffPrepare: {
        handoffID,
        targetRuntimeID: target.runtimeID,
        expectedBindingEpoch: 1,
        expectedControlRevision: 0,
        mappingPlanRevision: 1,
      },
    },
    { headers: f.headers, throwOnError: true },
  )
  const prepared = Handoff.MachineResult.parse(
    (
      await f.client.orgHandoff.drive(
        { handoffID, orgHandoffDrive: { requestID: "explicit-prepare", operation: "prepare-source" } },
        { headers: f.headers, throwOnError: true },
      )
    ).data,
  )
  expect(prepared.state).toBe("blocked")
  expect(prepared.facts).toEqual([])
  expect(called).toBe(1)
  if (!captured) throw new Error("Expected a verified machine plan")
  const wire = await sourceWire.promise
  wire.send(
    JSON.stringify({
      type: "command",
      connectionEpoch: connection.connected.connectionEpoch,
      exchangeID: "invalid-service-plan",
      command: {
        kind: "handoff",
        authorization: { ...captured, plan: { ...captured.plan, commandSeq: captured.plan.commandSeq + 1 } },
      },
    }),
  )
  expect(await invalid.promise).toMatchObject({ kind: "error", error: { code: "PERMISSION_DENIED" } })
  expect(called).toBe(1)
  await f.client.orgHandoff.cancel({ handoffID, body: {} }, { headers: f.headers, throwOnError: true })
  const cancelled = Handoff.MachineResult.parse(
    (
      await f.client.orgHandoff.drive(
        { handoffID, orgHandoffDrive: { requestID: "explicit-cancel", operation: "cancel-source" } },
        { headers: f.headers, throwOnError: true },
      )
    ).data,
  )
  expect(cancelled.state).toBe("complete")
  expect(cancelled.facts[0]?.proof.purpose).toBe("source-cancelled")
  const fact = cancelled.facts[0]
  if (!fact) throw new Error("Expected the source's durable cancellation proof")
  expect(await Handoff.verifyProof(fact.proof, fact.signature, member.publicKey)).toBe(true)
  expect((await f.client.orgHandoff.get({ handoffID }, { headers: f.headers, throwOnError: true })).data.phase).toBe(
    "cancelled",
  )
  expect(await native.run(() => Session.get(sessionID))).toMatchObject({
    paused: expect.anything(),
    organization: { driverRuntimeID: source.runtimeID, bindingEpoch: 1 },
  })
}, 15000)
