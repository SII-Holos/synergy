import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
  SessionTransferStaging as Staging,
  SessionTransferWorkspaces as Files,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationHandoffObjects as Objects } from "./handoff-objects"
import { OrganizationHandoffReceive as Receive } from "./handoff-receive"
import { OrganizationSessionAdoption as Adoption } from "./session-adoption"
import type { MemberResourceClient } from "./resource-client"
import { OrganizationRuntimeError } from "./error"
import { RuntimeIdentity } from "./home"
import { assertHandoffHome } from "./handoff-home"

export namespace OrganizationHandoffTarget {
  type Mapping = Owners.TargetContext["mapping"]
  interface Input {
    authorization: Handoff.SignedMachinePlan
    connection: z.infer<typeof Runtime.Connected>
    mapping(session: Readonly<Session.Info>): Promise<Mapping>
    signal: AbortSignal
  }
  const Receipt = z.strictObject({ version: z.literal(1), plan: Handoff.MachinePlan, fact: Handoff.Proof })
  const Mapping = z.record(z.string(), z.json())
  function snapshot(input: Input): Input {
    return {
      authorization: Handoff.SignedMachinePlan.parse(input.authorization),
      connection: Runtime.Connected.parse(input.connection),
      signal: input.signal,
      mapping: input.mapping.bind(input),
    }
  }
  const identity = [
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
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const ordered = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  export function compatibilityHash(owners: Readonly<Record<string, number>>) {
    return hash({ version: 1, owners: Object.entries(owners).sort(([left], [right]) => ordered(left, right)) })
  }
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "rejected", retryable: false })
  }
  function same(left: Handoff.MachinePlan, right: Handoff.MachinePlan) {
    return (
      identity.every((field) => left[field] === right[field]) &&
      JSON.stringify(left.sourceBinding) === JSON.stringify(right.sourceBinding)
    )
  }
  function factBinding(plan: Handoff.MachinePlan) {
    return Object.fromEntries(
      ["schemaVersion", ...identity].map((key) => [key, plan[key as keyof Handoff.MachinePlan]]),
    )
  }
  function binding(plan: Handoff.MachinePlan, sessionID = plan.sessionID): Epochs.Binding {
    return {
      sessionID,
      scopeID: plan.sourceBinding.projectID,
      handoffID: plan.handoffID,
      sourceID: plan.sourceRuntimeID,
      targetID: plan.targetRuntimeID,
      fromEpoch: plan.fromEpoch,
      toEpoch: plan.toEpoch,
      ...(sessionID === plan.sessionID ? {} : { rootSessionID: plan.sessionID }),
    }
  }
  function stable(value: z.infer<typeof Mapping>[string]): z.infer<typeof Mapping>[string] {
    if (Array.isArray(value)) return value.map(stable)
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => ordered(left, right))
          .map(([key, item]) => [key, stable(item)]),
      )
    return value
  }
  function ownerOrder(ids: string[]) {
    const selected = new Set<string>()
    const visiting = new Set<string>()
    const ordered: string[] = []
    const visit = (id: string) => {
      if (selected.has(id)) return
      if (visiting.has(id)) fail("Destination portability owners have cyclic preparation dependencies")
      visiting.add(id)
      for (const dependency of Owners.stagedDependencies(id)) {
        if (!ids.includes(dependency)) fail("Destination preparation omits a required native dependency")
        visit(dependency)
      }
      visiting.delete(id)
      selected.add(id)
      ordered.push(id)
    }
    if (!ids.includes("session-core")) fail("Destination preparation has no canonical Core owner")
    visit("session-core")
    for (const id of ids.sort()) visit(id)
    return ordered
  }
  export function create(options: { identity: RuntimeIdentity; runtimeID: string }) {
    const identity = RuntimeIdentity.parse(options.identity)
    const runtimeID = z.string().min(1).max(128).parse(options.runtimeID)
    const runtime = RuntimeContext.current()
    const jobs = new Map<string, { plan: Handoff.MachinePlan; promise: Promise<Handoff.Proof> }>()
    const current = Storage.current()
    const storage = {
      store: current.store,
      artifactDirectory: current.artifactDirectory,
      artifactObjects: current.artifactObjects,
    }
    function assertOwner(signal: AbortSignal) {
      signal.throwIfAborted()
      const active = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        active.store !== storage.store ||
        active.artifactDirectory !== storage.artifactDirectory ||
        active.artifactObjects !== storage.artifactObjects
      )
        fail("Destination controller belongs to another Runtime or storage owner")
    }
    async function authorize(input: Input, operation: "prepare-target" | "activate-target" | "inspect-target") {
      assertOwner(input.signal)
      const { plan, signature } = Handoff.SignedMachinePlan.parse(input.authorization)
      const connection = Runtime.Connected.parse(input.connection)
      if (
        plan.operation !== operation ||
        plan.runtimeID !== runtimeID ||
        plan.orgID !== identity.orgID ||
        plan.runtimeID !== connection.runtimeID ||
        plan.targetRuntimeID !== connection.runtimeID ||
        plan.connectionEpoch !== connection.connectionEpoch ||
        plan.orgID !== connection.orgID ||
        plan.deploymentIncarnation !== connection.deploymentIncarnation ||
        plan.keyID !== connection.signingIdentity.keyID ||
        plan.issuedAt > Date.now() ||
        plan.expiresAt <= Date.now() ||
        !(await Handoff.verifyMachinePlan(plan, signature, connection.signingIdentity.publicKey))
      )
        fail("Destination controller requires the current finite service authorization")
      assertOwner(input.signal)
      await assertHandoffHome(identity, runtimeID, plan)
      assertOwner(input.signal)
      const manifestHash = plan.manifestHash
      const frozen = plan.frozen?.proof
      if (!manifestHash || !frozen || frozen.purpose !== "source-frozen")
        fail("Destination preparation requires the authoritative frozen source fact")
      return { plan, manifestHash, frozen }
    }
    const key = (plan: Handoff.MachinePlan, kind: "prepared" | "activated") => [
      "organization_handoff_target",
      plan.orgID,
      plan.deploymentIncarnation,
      plan.handoffID,
      kind,
    ]
    async function receipt(plan: Handoff.MachinePlan, kind: "prepared" | "activated") {
      const [raw] = await Storage.readMany([key(plan, kind)])
      if (raw === undefined) return
      const saved = Receipt.parse(raw)
      if (!same(plan, saved.plan) || saved.plan.manifestHash !== plan.manifestHash)
        fail("Destination receipt belongs to another immutable handoff")
      if (saved.fact.purpose !== (kind === "prepared" ? "target-prepared" : "target-activated"))
        fail("Destination receipt has another native purpose")
      return saved
    }
    async function contexts(input: Input, plan: Handoff.MachinePlan, manifestHash: string, retain: boolean) {
      const core: { ownerID: string; context: Owners.TargetContext }[] = []
      const remaining: typeof core = []
      const bindings: Epochs.Binding[] = []
      const converted = createHash("sha256").update("synergy.organization.destination.mapping.v1\n" + plan.manifestHash)
      for await (const member of Staging.members({
        handoffID: plan.handoffID,
        rootSessionID: plan.sessionID,
        scopeID: plan.sourceBinding.projectID,
        signal: input.signal,
      })) {
        assertOwner(input.signal)
        if (member.session.workspaceID && !member.owners["session-workspaces"])
          throw new Owners.Rejected({
            message: "Destination package omits its current Working location",
            requirements: [
              {
                code: "workspace_move_missing",
                owner: "session-workspaces",
                label: "Capture and verify the final Workspace files before handoff",
                recoverable: true,
              },
            ],
          })
        const selected = Mapping.parse(await input.mapping(member.session))
        const frozen = plan.frozen?.proof
        if (frozen?.purpose === "source-frozen" && frozen.fileClosureHash !== null) {
          const native = await Files.targetMapping({
            handoffID: plan.handoffID,
            sessionID: member.session.id,
            signal: input.signal,
          })
          const supplied = selected.workspaceIDs
          if (supplied !== undefined && (supplied === null || Array.isArray(supplied) || typeof supplied !== "object"))
            fail("Destination Workspace mapping must name the exact prepared native identities")
          for (const [sourceID, targetID] of Object.entries(supplied ?? {}))
            if (native.workspaceIDs[sourceID] !== targetID)
              fail("Destination Workspace mapping conflicts with its prepared native identity")
          if (
            selected.workspaceReceiptHash !== undefined &&
            selected.workspaceReceiptHash !== native.workspaceReceiptHash
          )
            fail("Destination Workspace mapping conflicts with its prepared native receipt")
          selected.workspaceIDs = native.workspaceIDs
          selected.workspaceReceiptHash = native.workspaceReceiptHash
        }
        const mapping = Object.fromEntries(
          Object.entries(selected)
            .sort(([left], [right]) => ordered(left, right))
            .map(([name, value]) => [name, stable(value)]),
        )
        converted.update(JSON.stringify([member.session.id, mapping]))
        const reservation = binding(plan, member.session.id)
        await Epochs.reserve(reservation, manifestHash)
        if (retain) bindings.push(reservation)
        for (const ownerID of ownerOrder(Object.keys(member.owners))) {
          const context = await Staging.context({
            ownerID,
            session: member.session,
            rootSessionID: plan.sessionID,
            handoffID: plan.handoffID,
            mapping,
            signal: input.signal,
          })
          await Owners.validate(ownerID, context)
          if (retain) (ownerID === "session-core" ? core : remaining).push({ ownerID, context })
        }
      }
      assertOwner(input.signal)
      return { convertedHash: converted.digest("hex"), bindings, contexts: [...core, ...remaining] }
    }
    return {
      async inspect(value: Input): Promise<Handoff.MachineExecution> {
        const input = snapshot(value)
        const { plan, manifestHash } = await authorize(input, "inspect-target")
        const activated = await receipt(plan, "activated")
        const prepared = activated ?? (await receipt(plan, "prepared"))
        const fact = prepared?.fact
        const job = jobs.get(plan.handoffID)
        if (job && (!same(plan, job.plan) || job.plan.manifestHash !== manifestHash))
          fail("Destination inspection belongs to another preparation")
        if (fact) {
          const epoch = await Epochs.inspect(binding(plan))
          if (
            epoch.role !== "target" ||
            epoch.manifestHash !== manifestHash ||
            epoch.phase !== (activated ? "activated" : "prepared")
          )
            fail("Destination inspection has no matching permanent native outcome")
        }
        assertOwner(input.signal)
        return Handoff.MachineExecution.parse({
          handoffID: plan.handoffID,
          requestID: plan.requestID,
          runtimeID: plan.runtimeID,
          operation: plan.operation,
          state: fact ? "complete" : job ? "working" : "idle",
          stage: fact?.purpose ?? (job ? "preparing" : "idle"),
          revision: fact
            ? await Handoff.proofHash(fact)
            : hash({ handoffID: plan.handoffID, manifestHash, stage: job ? "preparing" : "idle" }),
          requirements: [],
          facts: fact ? [fact] : [],
        })
      },
      async prepare(value: Input & { resources: Pick<MemberResourceClient, "handoffObject"> }): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const read = value.resources.handoffObject.bind(value.resources)
        const { plan, manifestHash, frozen } = await authorize(input, "prepare-target")
        const previous = jobs.get(plan.handoffID)
        if (previous) {
          if (
            !same(plan, previous.plan) ||
            previous.plan.manifestHash !== manifestHash ||
            previous.plan.connectionEpoch !== plan.connectionEpoch ||
            previous.plan.commandSeq !== plan.commandSeq
          )
            fail("Destination preparation is already using another immutable handoff")
          return previous.promise
        }
        const promise = (async () => {
          const objects = await Objects.open(
            {
              orgID: plan.orgID,
              deploymentIncarnation: plan.deploymentIncarnation,
              role: "target",
              binding: binding(plan),
            },
            input.signal,
          )
          const receive = Receive.open({
            manifestHash,
            signal: input.signal,
            cache: { store: objects.store, contains: objects.contains },
            read: ({ manifestHash, ...range }) =>
              read(
                {
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
                  manifestHash,
                },
                range,
                input.signal,
              ),
          })
          const root = await receive.root()
          if (compatibilityHash(root.owners) !== frozen.compatibilityHash)
            fail("Destination reader contract differs from its frozen source fact")
          await Staging.receive({ handoffID: plan.handoffID, root, store: receive.store, signal: input.signal })
          await Staging.verify(plan.handoffID, input.signal)
          const aggregate = await Staging.prepareAggregate({
            handoffID: plan.handoffID,
            rootSessionID: plan.sessionID,
            scopeID: plan.sourceBinding.projectID,
            signal: input.signal,
          })
          if (aggregate.digest !== frozen.closureHash)
            fail("Destination native cohort differs from its frozen source closure")
          if (Boolean(root.owners["session-workspaces"]) !== (frozen.fileClosureHash !== null))
            fail("Destination Workspace owner does not match the frozen file closure")
          if (frozen.fileClosureHash !== null)
            await Files.prepareTarget({
              binding: binding(plan),
              expectedReceiptHash: frozen.fileClosureHash,
              signal: input.signal,
            })
          const prepared = await contexts(input, plan, manifestHash, false)
          const fact = Handoff.Proof.parse({
            ...factBinding(plan),
            purpose: "target-prepared",
            manifestHash,
            compatibilityHash: compatibilityHash(root.owners),
            convertedHash: prepared.convertedHash,
            closureHash: aggregate.digest,
            fileClosureHash: frozen.fileClosureHash,
            workspaceMoveReceiptHash: frozen.workspaceMoveReceiptHash,
            paused: true,
          })
          assertOwner(input.signal)
          return Storage.transaction(
            async () => {
              const existing = await receipt(plan, "prepared")
              if (existing && JSON.stringify(existing.fact) !== JSON.stringify(fact))
                fail("Destination preparation cannot change its immutable mapping")
              if (existing) return existing.fact
              await Storage.write(key(plan, "prepared"), Receipt.parse({ version: 1, plan, fact }))
              return fact
            },
            {
              commitGuard() {
                assertOwner(input.signal)
              },
            },
          )
        })()
        jobs.set(plan.handoffID, { plan, promise })
        try {
          return await promise
        } finally {
          if (jobs.get(plan.handoffID)?.promise === promise) jobs.delete(plan.handoffID)
        }
      },
      async activate(value: Input): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const { plan, manifestHash } = await authorize(input, "activate-target")
        const saved = await receipt(plan, "prepared")
        const signedPermit = plan.authorization
        const permit = signedPermit?.permit
        if (
          !saved ||
          !permit ||
          !signedPermit ||
          saved.fact.purpose !== "target-prepared" ||
          permit.preparedHash !== (await Handoff.proofHash(saved.fact))
        )
          fail("Destination activation requires its exact retained preparation")
        const preparedFact = saved.fact
        return Adoption.run(signedPermit, input.connection, async () => {
          const previous = await receipt(plan, "activated")
          if (previous) {
            const epoch = await Epochs.inspect(binding(plan))
            if (
              epoch.role !== "target" ||
              epoch.phase !== "activated" ||
              epoch.manifestHash !== plan.manifestHash ||
              previous.fact.purpose !== "target-activated" ||
              previous.fact.permitID !== permit.permitID
            )
              fail("Destination activation receipt no longer matches its permanent epoch")
            return previous.fact
          }
          await Staging.verify(plan.handoffID, input.signal)
          const prepared = await contexts(input, plan, manifestHash, true)
          if (prepared.convertedHash !== preparedFact.convertedHash)
            fail("Destination mapping changed before paused publication")
          const fact = Handoff.Proof.parse({
            ...factBinding(plan),
            purpose: "target-activated",
            manifestHash: plan.manifestHash,
            permitID: permit.permitID,
            preparedHash: permit.preparedHash,
            paused: true,
          })
          const publish = () =>
            Epochs.activateMany({
              bindings: prepared.bindings,
              manifestHash,
              signal: input.signal,
              async publish() {
                assertOwner(input.signal)
                await Staging.publish({ handoffID: plan.handoffID, contexts: prepared.contexts })
                await Storage.write(key(plan, "activated"), Receipt.parse({ version: 1, plan, fact }))
                assertOwner(input.signal)
              },
            })
          if (preparedFact.fileClosureHash !== null)
            await Files.withTargetPublication({ handoffID: plan.handoffID, signal: input.signal }, publish)
          else await publish()
          assertOwner(input.signal)
          return fact
        })
      },
    }
  }
}
