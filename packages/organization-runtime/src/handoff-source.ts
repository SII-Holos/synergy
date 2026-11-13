import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationExecutionProtocol as Execution,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import {
  SessionTransferSource as NativeSource,
  SessionTransferWorkspaces as Files,
  SessionTransferEnvironments as Environments,
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { NativeSessionTransferPhysical as Physical } from "@ericsanchezok/synergy-local-runtime/session-transfer-physical"
import { OrganizationHandoffObjects as Objects } from "./handoff-objects"
import { OrganizationHandoffTarget as Target } from "./handoff-target"
import { createCommandIntake } from "./command-intake"
import { RuntimeIdentity } from "./home"
import { assertHandoffHome } from "./handoff-home"
import { OrganizationRuntimeError } from "./error"
import { OrganizationHandoffEnvironments } from "./handoff-environment"
import type { MemberResourceClient } from "./resource-client"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { OrganizationSessionTransfer as Transfer } from "./session-transfer"
import { OrganizationHandoffWorkspaceSource as WorkspaceSource } from "./handoff-workspace-source"
import { OrganizationHandoffWorkspaceDrain as WorkspaceDrain } from "./handoff-workspace-drain"
import { OrganizationHandoffSourceReceipts as SourceReceipts } from "./handoff-source-receipts"

export namespace OrganizationHandoffSource {
  interface Input {
    authorization: Handoff.SignedMachinePlan
    connection: z.infer<typeof Runtime.Connected>
    signal: AbortSignal
    resources?: MemberResourceClient
  }
  const ResourceClosure = z.strictObject({
    binding: Handoff.Binding,
    manifestHash: OrganizationProtocol.Digest,
    preparedHash: OrganizationProtocol.Digest,
    closedAt: z.number().int().nonnegative(),
  })
  const fields = [
    "schemaVersion",
    "orgID",
    "deploymentIncarnation",
    "handoffID",
    "sessionID",
    "sourceRuntimeID",
    "targetRuntimeID",
    "fromEpoch",
    "toEpoch",
    "mappingPlanRevision",
    "shareGeneration",
  ] as const
  const factBinding = (plan: Handoff.MachinePlan) => Object.fromEntries(fields.map((field) => [field, plan[field]]))
  const binding = (plan: Handoff.MachinePlan): Epochs.Binding => ({
    sessionID: plan.sessionID,
    scopeID: plan.sourceBinding.projectID,
    handoffID: plan.handoffID,
    sourceID: plan.sourceRuntimeID,
    targetID: plan.targetRuntimeID,
    fromEpoch: plan.fromEpoch,
    toEpoch: plan.toEpoch,
  })
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "rejected", retryable: false })
  }
  function snapshot(input: Input): Input {
    return {
      authorization: Handoff.SignedMachinePlan.parse(input.authorization),
      connection: Runtime.Connected.parse(input.connection),
      signal: input.signal,
      resources: input.resources && { ...input.resources },
    }
  }
  export function create(options: { identity: RuntimeIdentity; runtimeID: string }) {
    const identity = RuntimeIdentity.parse(options.identity)
    const runtimeID = z.string().min(1).max(128).parse(options.runtimeID)
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const storage = {
      store: handle.store,
      artifactDirectory: handle.artifactDirectory,
      artifactObjects: handle.artifactObjects,
    }
    const stop = new AbortController()
    const leases = new Map<string, Physical.Lease>()
    const jobs = new Map<
      string,
      { plan: Handoff.MachinePlan; abort: AbortController; promise: Promise<Handoff.Proof> }
    >()
    let closing: Promise<void> | undefined
    const factKey = SourceReceipts.key
    function assertOwner() {
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== storage.store ||
        current.artifactDirectory !== storage.artifactDirectory ||
        current.artifactObjects !== storage.artifactObjects
      )
        fail("Source controller belongs to another Runtime or storage owner")
    }
    async function authorize(input: Input, operation: Handoff.MachineOperation) {
      assertOwner()
      stop.signal.throwIfAborted()
      input.signal.throwIfAborted()
      const { plan, signature } = Handoff.SignedMachinePlan.parse(input.authorization)
      const connection = Runtime.Connected.parse(input.connection)
      if (
        plan.operation !== operation ||
        Handoff.machineRole(operation) !== "source" ||
        plan.runtimeID !== runtimeID ||
        plan.sourceRuntimeID !== runtimeID ||
        connection.runtimeID !== runtimeID ||
        plan.orgID !== identity.orgID ||
        connection.orgID !== plan.orgID ||
        plan.deploymentIncarnation !== connection.deploymentIncarnation ||
        plan.connectionEpoch !== connection.connectionEpoch ||
        plan.keyID !== connection.signingIdentity.keyID ||
        plan.issuedAt > Date.now() ||
        plan.expiresAt <= Date.now() ||
        !(await Handoff.verifyMachinePlan(plan, signature, connection.signingIdentity.publicKey))
      )
        fail("Source controller requires the current finite service authorization")
      input.signal.throwIfAborted()
      await assertHandoffHome(identity, runtimeID, plan)
      if (plan.environmentPlan) OrganizationHandoffEnvironments.assertPlan(plan, "source")
      const session = await Session.get(plan.sessionID)
      if (
        session.parentID ||
        session.scope.id !== plan.sourceBinding.projectID ||
        JSON.stringify(session.organization) !== JSON.stringify(plan.sourceBinding)
      )
        fail("Source controller does not own this canonical Session binding")
      assertOwner()
      return { plan, session }
    }
    function intake(input: Input) {
      return createCommandIntake({
        identity: input.connection.signingIdentity,
        runtimeID,
        accountID: "accountID" in identity ? identity.accountID : undefined,
        connectionEpoch: input.connection.connectionEpoch,
        signal: input.signal,
      })
    }
    async function objects(plan: Handoff.MachinePlan, signal: AbortSignal) {
      return Objects.open(
        {
          orgID: plan.orgID,
          deploymentIncarnation: plan.deploymentIncarnation,
          role: "source",
          binding: binding(plan),
        },
        signal,
      )
    }
    async function supportedCohort(plan: Handoff.MachinePlan, signal: AbortSignal) {
      for await (const member of NativeSource.members(binding(plan), signal)) {
        const session = await Session.get(member.binding.sessionID)
        if ((session.workspaceID || session.workspace) && Owners.compatibility({ "session-workspaces": 1 }).length)
          throw new Owners.Rejected({
            message: "Source Working location needs its final file closure",
            requirements: [
              {
                code: "workspace_move_missing",
                owner: "session-workspaces",
                label: "Capture and verify final Workspace files before handoff",
                recoverable: true,
              },
            ],
          })
        if (session.environmentID) {
          if (Owners.compatibility({ "session-environments": 2 }).length)
            throw new Owners.Rejected({
              message: "Source Environment needs its retained-use transfer proof",
              requirements: [
                {
                  code: "environment_transfer_missing",
                  owner: "session-environments",
                  label: "Drain and transfer the exact Session Environment use",
                  recoverable: true,
                },
              ],
            })
          await Environments.assertPreparedSource({ binding: member.binding, signal })
        }
      }
    }
    async function release(handoffID: string) {
      const lease = leases.get(handoffID)
      if (!lease) return
      await Physical.release(lease)
      leases.delete(handoffID)
    }
    async function moveWorkspace(
      plan: Handoff.MachinePlan,
      resources: MemberResourceClient | undefined,
      signal: AbortSignal,
    ) {
      const mapping = plan.workspacePlan?.mapping
      if (!mapping || mapping.kind !== "organization-object") return
      if (!resources) fail("Workspace move requires the original machine resource client")
      const send = resources.handoffWorkspace.bind(resources)
      const session = await Session.get(plan.sessionID)
      if (session.workspaceID !== mapping.source.workspaceID)
        fail("Consented move has another current Working location")
      for await (const member of NativeSource.members(binding(plan), signal)) {
        const child = await Session.get(member.binding.sessionID)
        if (child.workspaceID && child.workspaceID !== mapping.source.workspaceID)
          fail("This mapping cannot transfer additional current Working locations")
      }
      const previous = await Transfer.workspaceMoveSource(binding(plan))
      if (previous) {
        await Files.withCaptured({ binding: binding(plan), ...mapping.source, signal }, async (snapshot) => {
          if (snapshot.manifest !== previous.source.manifest)
            fail("The original uncertain Workspace move cannot recapture different final bytes")
          snapshot.assert()
        })
        const inspected = await send(plan, { action: "inspect" }, signal)
        const receipt =
          inspected.action === "inspect" && inspected.status !== undefined
            ? WorkspaceMove.Status.parse(inspected.status).receipt
            : undefined
        if (!receipt || JSON.stringify(receipt.source) !== JSON.stringify(previous.source))
          fail("Inspect the original uncertain Workspace move before continuing its source freeze")
        await Transfer.retainWorkspaceMove(binding(plan), receipt, signal)
        return
      }
      await Files.withCaptured({ binding: binding(plan), ...mapping.source, signal }, async (snapshot) => {
        const catalog = await WorkspaceCatalog.get(mapping.source.workspaceID, plan.sourceBinding.projectID)
        if (!catalog.binding.physicalID || catalog.binding.generation !== mapping.source.generation)
          fail("Consented Workspace move lost its original native identity")
        snapshot.assert()
        await WorkspaceArchive.copyManifest(
          { manifest: snapshot.manifest, source: snapshot.store },
          {
            async put(hash, bytes) {
              snapshot.assert()
              await send(
                plan,
                {
                  action: "put",
                  hash,
                  data: Buffer.from(bytes).toString("base64"),
                },
                signal,
              )
              snapshot.assert()
            },
          },
          signal,
        )
        const source = WorkspaceMove.CapturedSource.parse({
          ...mapping.source,
          scopeID: plan.sourceBinding.projectID,
          hostID: catalog.binding.hostID,
          physicalID: catalog.binding.physicalID,
          manifest: snapshot.manifest,
        })
        await Transfer.retainWorkspaceMoveSource(binding(plan), source, signal)
        const result = await send(plan, { action: "publish", source }, signal)
        snapshot.assert()
        if (result.action !== "publish") fail("Workspace move returned another operation")
        await Transfer.retainWorkspaceMove(binding(plan), WorkspaceMove.Receipt.parse(result.receipt), signal)
      })
    }
    async function capture(plan: Handoff.MachinePlan, signal: AbortSignal, resources?: MemberResourceClient) {
      await supportedCohort(plan, signal)
      await release(plan.handoffID)
      const lease = await Physical.begin({ ...binding(plan), rootSessionID: plan.sessionID }, { signal })
      leases.set(plan.handoffID, lease)
      await Physical.withCapture(lease, async () => {
        await supportedCohort(plan, signal)
        if (!Owners.compatibility({ "session-workspaces": 1 }).length)
          await WorkspaceSource.run(plan, resources, signal, () => Files.capture({ binding: binding(plan), signal }))
        await WorkspaceSource.retainNative(plan, signal)
        await moveWorkspace(plan, resources, signal)
      })
      Physical.assertCurrent(lease)
      return lease
    }
    async function resourceClosure(plan: Handoff.MachinePlan) {
      const [raw] = await Storage.readMany([factKey(plan, "resource-closure")])
      const proof = ResourceClosure.parse(raw)
      if (
        JSON.stringify(proof.binding) !== JSON.stringify(factBinding(plan)) ||
        proof.manifestHash !== plan.manifestHash ||
        proof.preparedHash !== plan.preparedHash
      )
        fail("Source resource closure belongs to another immutable handoff")
    }
    async function closeResources(input: Input, commands: ReturnType<typeof createCommandIntake>, signal: AbortSignal) {
      const plan = input.authorization.plan
      const resources = input.resources
      if (!resources) fail("Source resource closure requires the current machine resource client")
      let cursor: string | undefined
      while (true) {
        assertOwner()
        signal.throwIfAborted()
        const issuedAt = Date.now()
        const page = await resources.handoffInventory(
          Execution.HandoffInventoryProof.parse({
            ...factBinding(plan),
            purpose: "execution-handoff-inventory",
            runtimeID,
            connectionEpoch: input.connection.connectionEpoch,
            manifestHash: plan.manifestHash,
            preparedHash: plan.preparedHash,
            cursor,
            issuedAt,
            expiresAt: Math.min(issuedAt + 30_000, plan.expiresAt),
          }),
          signal,
        )
        assertOwner()
        if (!page.items.length) {
          if (page.retained || page.cursor || cursor) {
            if (cursor && !page.retained && !page.cursor) {
              cursor = undefined
              continue
            }
            fail("Source retained resource inventory is incomplete")
          }
          await Storage.transaction(
            async () => {
              await Epochs.assertFrozen(plan.sessionID, plan.handoffID)
              await Storage.write(
                factKey(plan, "resource-closure"),
                ResourceClosure.parse({
                  binding: factBinding(plan),
                  manifestHash: plan.manifestHash,
                  preparedHash: plan.preparedHash,
                  closedAt: Date.now(),
                }),
              )
            },
            {
              commitGuard() {
                assertOwner()
                signal.throwIfAborted()
              },
            },
          )
          return
        }
        for (const item of page.items) {
          const proof = await commands.handoffCloseProof({ authorization: input.authorization, item })
          const receipt = await resources.closeHandoff(proof, signal)
          assertOwner()
          signal.throwIfAborted()
          const key = [...factKey(plan, "resource-receipts"), receipt.grantID, String(receipt.generation)]
          await Storage.transaction(
            async () => {
              const [prior] = await Storage.readMany([key])
              if (
                prior !== undefined &&
                JSON.stringify(Execution.HandoffCloseReceipt.parse(prior)) !== JSON.stringify(receipt)
              )
                fail("Source resource closure cannot replace a generation receipt")
              if (prior === undefined) await Storage.write(key, receipt)
            },
            {
              commitGuard() {
                assertOwner()
                signal.throwIfAborted()
              },
            },
          )
        }
        cursor = page.cursor
      }
    }
    return {
      async inspect(value: Input): Promise<Handoff.MachineExecution> {
        const input = snapshot(value)
        const { plan } = await authorize(input, "inspect-source")
        const retained = await SourceReceipts.inspect(plan, {
          scopeID: plan.sourceBinding.projectID,
          signal: input.signal,
        })
        const prepared = retained ? undefined : await NativeSource.status(binding(plan))
        let fact: Handoff.Proof | undefined
        let stage: Handoff.MachineExecution["stage"] = "preparing"
        const requirements: z.infer<typeof Handoff.Requirement>[] = []
        if (retained) {
          stage = retained.stage
          fact = retained.fact
          if (!fact)
            requirements.push({
              code: "surrender_permit_receipt",
              label: "Reconcile the original surrender permit before publishing its fact",
              recoverable: true,
            })
        } else if (prepared) {
          stage = "source-frozen"
          const [raw] = await Storage.readMany([factKey(plan, "frozen")])
          const lease = leases.get(plan.handoffID)
          if (raw !== undefined && lease) {
            Physical.assertCurrent(lease)
            const saved = Handoff.Proof.parse(raw)
            if (
              saved.purpose !== stage ||
              !fields.every((field) => saved[field] === plan[field]) ||
              saved.manifestHash !== prepared.manifestHash ||
              saved.closureHash !== prepared.closureHash
            )
              fail("Source frozen receipt changed its native closure")
            fact = saved
          } else
            requirements.push({
              code: "current_physical_writer_proof",
              label: "Explicitly prepare the source to revalidate its physical writer and sealed objects",
              recoverable: true,
            })
        } else
          requirements.push({
            code: "source_preparation",
            label: "Inspect or explicitly continue the incomplete source preparation",
            recoverable: true,
          })
        assertOwner()
        return Handoff.MachineExecution.parse({
          handoffID: plan.handoffID,
          requestID: plan.requestID,
          runtimeID: plan.runtimeID,
          operation: plan.operation,
          state: fact ? "complete" : jobs.has(plan.handoffID) ? "working" : "blocked",
          stage,
          revision: fact
            ? await Handoff.proofHash(fact)
            : createHash("sha256").update(JSON.stringify({ stage, requirements })).digest("hex"),
          requirements,
          facts: fact ? [fact] : [],
        })
      },
      async prepare(value: Input): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const { plan, session } = await authorize(input, "prepare-source")
        const previous = jobs.get(plan.handoffID)
        if (previous) {
          if (
            !fields.every((field) => previous.plan[field] === plan[field]) ||
            previous.plan.environmentPlan?.hash !== plan.environmentPlan?.hash ||
            previous.plan.commandSeq !== plan.commandSeq
          )
            fail("Source preparation is already using another immutable handoff")
          return previous.promise
        }
        const abort = new AbortController()
        const signal = AbortSignal.any([input.signal, stop.signal, abort.signal])
        const promise = ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: async () => {
            const source = await objects(plan, signal)
            const commands = intake({ ...input, signal })
            let lease: Physical.Lease | undefined
            const verify = async () => {
              assertOwner()
              signal.throwIfAborted()
              await commands.barrier(plan.sessionID, plan.fromEpoch, plan.commandSeq)
              if (lease) Physical.assertCurrent(lease)
            }
            const prepared = await NativeSource.prepare({
              binding: binding(plan),
              store: source.store,
              signal,
              verify,
              async beforeOwnerFreeze(context) {
                const assert = () => {
                  assertOwner()
                  signal.throwIfAborted()
                  if (plan.environmentPlan) OrganizationHandoffEnvironments.assertPlan(plan, "source")
                  if (plan.issuedAt > Date.now() || plan.expiresAt <= Date.now())
                    fail("Native Workspace drainage requires its current finite handoff plan")
                }
                await WorkspaceDrain.prepare(plan, context, assert, verify)
              },
              async beforeFreeze() {
                lease = await capture(plan, signal, input.resources)
              },
            })
            if (!lease) lease = await capture(plan, signal, input.resources)
            await source.sealSource()
            await verify()
            const files = prepared.root.owners["session-workspaces"] ? await Files.receipt(binding(plan)) : undefined
            if (prepared.root.owners["session-workspaces"] && !files)
              fail("Source frozen Workspace owner has no completed native file closure")
            const fact = Handoff.Proof.parse({
              ...factBinding(plan),
              purpose: "source-frozen",
              ...(plan.environmentPlan ? { environmentMappingHash: plan.environmentPlan.hash } : {}),
              manifestHash: prepared.manifestHash,
              commandSeq: plan.commandSeq,
              receivedSeq: plan.commandSeq,
              compatibilityHash: Target.compatibilityHash(prepared.root.owners),
              closureHash: prepared.closureHash,
              fileClosureHash: files?.hash ?? null,
              workspaceMoveReceiptHash: await Transfer.workspaceMove(binding(plan)).then((receipt) =>
                receipt ? WorkspaceMove.receiptHash(receipt) : null,
              ),
              ...(plan.workspacePlan?.mapping.kind === "organization-live" ||
              plan.workspacePlan?.mapping.kind === "organization-native" ||
              plan.workspacePlan?.mapping.kind === "native-existing"
                ? {
                    workspaceSourceHash: await Transfer.workspaceSource(binding(plan)).then((snapshot) =>
                      snapshot ? WorkspaceArchive.subtreeHash(snapshot) : null,
                    ),
                  }
                : {}),
              paused: true,
              drained: true,
            })
            await Storage.write(factKey(plan, "frozen"), fact)
            return fact
          },
        })
        jobs.set(plan.handoffID, { plan, abort, promise })
        try {
          return await promise
        } finally {
          if (jobs.get(plan.handoffID)?.promise === promise) jobs.delete(plan.handoffID)
        }
      },
      async cancel(value: Input): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const { plan, session } = await authorize(input, "cancel-source")
        const previous = jobs.get(plan.handoffID)
        if (previous) {
          if (
            !fields.every((field) => previous.plan[field] === plan[field]) ||
            previous.plan.commandSeq !== plan.commandSeq
          )
            fail("Source cancellation belongs to another immutable handoff")
          previous.abort.abort(new Error("Source cancellation requested"))
          await previous.promise.catch(() => {})
        }
        const signal = AbortSignal.any([input.signal, stop.signal])
        return ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: async () => {
            const source = await objects(plan, signal)
            const commands = intake({ ...input, signal })
            const cancelled = await NativeSource.cancel({
              binding: binding(plan),
              store: source.store,
              signal,
              async verify() {
                assertOwner()
                await commands.barrier(plan.sessionID, plan.fromEpoch, plan.commandSeq)
              },
            })
            await release(plan.handoffID)
            assertOwner()
            return Handoff.Proof.parse({
              ...factBinding(plan),
              purpose: "source-cancelled",
              manifestHash: cancelled.manifestHash,
              gateCancelled: true,
              paused: true,
            })
          },
        })
      },
      async surrender(value: Input): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const { plan, session } = await authorize(input, "surrender-source")
        const signed = plan.authorization
        if (
          !signed ||
          signed.permit.purpose !== "handoff-surrender" ||
          !(await Handoff.verifyPermit(signed.permit, signed.signature, input.connection.signingIdentity.publicKey))
        )
          fail("Source surrender requires its separate service permit")
        const signal = AbortSignal.any([input.signal, stop.signal])
        return ScopeContext.provide({
          scope: session.scope,
          workspace: session.workspace,
          fn: async () => {
            const prior = await NativeSource.surrendered(binding(plan))
            if (!prior) {
              const lease = await capture(plan, signal, input.resources)
              const commands = intake({ ...input, signal })
              await closeResources(input, commands, signal)
              await resourceClosure(plan)
              await NativeSource.surrender({
                binding: binding(plan),
                manifestHash: signed.permit.manifestHash,
                preparedHash: signed.permit.preparedHash,
                signal,
                async verify() {
                  assertOwner()
                  Physical.assertCurrent(lease)
                  await commands.barrier(plan.sessionID, plan.fromEpoch, plan.commandSeq)
                  await resourceClosure(plan)
                  const key = factKey(plan, "surrender-permit")
                  const [raw] = await Storage.readMany([key])
                  if (raw !== undefined && JSON.stringify(Handoff.SignedPermit.parse(raw)) !== JSON.stringify(signed))
                    fail("Source surrender cannot replace its signed permit receipt")
                  if (raw === undefined) await Storage.write(key, signed)
                },
              })
            } else if (
              prior.manifestHash !== signed.permit.manifestHash ||
              prior.preparedHash !== signed.permit.preparedHash
            )
              fail("Source surrender changed its immutable preparation")
            await release(plan.handoffID)
            assertOwner()
            return Handoff.Proof.parse({
              ...factBinding(plan),
              purpose: "source-surrendered",
              manifestHash: signed.permit.manifestHash,
              permitID: signed.permit.permitID,
              preparedHash: signed.permit.preparedHash,
              gatePersisted: true,
            })
          },
        })
      },
      async range(value: Input) {
        const input = snapshot(value)
        const { plan } = await authorize(input, "object")
        if (!plan.manifestHash || !plan.object) fail("Source range has no frozen package or immutable request")
        const source = await objects(plan, AbortSignal.any([input.signal, stop.signal]))
        return source.range({
          manifestHash: plan.manifestHash,
          hash: plan.object.hash,
          offset: plan.object.offset,
          limit: plan.object.length,
        })
      },
      close() {
        assertOwner()
        if (closing) return closing
        stop.abort(new Error("Source handoff controller closed"))
        closing = (async () => {
          await Promise.allSettled([...jobs.values()].map((job) => job.promise))
          const results = await Promise.allSettled([...leases.keys()].map(release))
          const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
          if (errors.length) throw new AggregateError(errors, "Source physical handoff claims could not be released")
        })()
        return closing
      },
    }
  }
}
