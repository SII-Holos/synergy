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
import { OrganizationHandoffWorkspaceTarget as WorkspaceTarget } from "./handoff-workspace-target"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { HandoffTargetRecord as Receipt, readHandoffTargetRecord } from "./handoff-target-record"

export namespace OrganizationHandoffTarget {
  type Mapping = Owners.TargetContext["mapping"]
  interface Input {
    authorization: Handoff.SignedMachinePlan
    connection: z.infer<typeof Runtime.Connected>
    mapping(session: Readonly<Session.Info>): Promise<Mapping>
    signal: AbortSignal
    resources?: Partial<Pick<MemberResourceClient, "handoffWorkspace">>
  }
  const Mapping = z.record(z.string(), z.json())
  function snapshot(input: Input): Input {
    return {
      authorization: Handoff.SignedMachinePlan.parse(input.authorization),
      connection: Runtime.Connected.parse(input.connection),
      signal: input.signal,
      mapping: input.mapping.bind(input),
      resources: input.resources?.handoffWorkspace
        ? { handoffWorkspace: input.resources.handoffWorkspace.bind(input.resources) }
        : undefined,
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
    const jobs = new Map<
      string,
      { plan: Handoff.MachinePlan; abort: AbortController; promise: Promise<Handoff.Proof> }
    >()
    const closing = new Set<string>()
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
    async function authorize(
      input: Input,
      operation: "prepare-target" | "preview-target" | "activate-target" | "inspect-target" | "retire-target",
    ) {
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
      if (
        plan.workspacePlan?.mapping.kind === "organization-native" &&
        (!("accountID" in identity) ||
          plan.workspacePlan.targetActor?.kind !== "account" ||
          plan.workspacePlan.targetActor.subjectID !== identity.accountID ||
          plan.workspacePlan.targetActor.orgID !== identity.orgID ||
          plan.workspacePlan.targetActor.requestID !== plan.handoffID)
      )
        fail("Native target consent belongs to another enrolled member")
      await assertHandoffHome(identity, runtimeID, plan)
      assertOwner(input.signal)
      const manifestHash = plan.manifestHash
      const frozen = plan.frozen?.proof
      if (!manifestHash || !frozen || frozen.purpose !== "source-frozen")
        fail("Destination preparation requires the authoritative frozen source fact")
      return { plan, manifestHash, frozen }
    }
    type Kind = "prepared" | "activated" | "retired" | "difference" | "preview-released"
    const key = (plan: Handoff.MachinePlan, kind: Kind) => [
      "organization_handoff_target",
      plan.orgID,
      plan.deploymentIncarnation,
      plan.handoffID,
      kind,
    ]
    async function receipt(plan: Handoff.MachinePlan, kind: Kind) {
      const [raw] = await Storage.readMany([key(plan, kind)])
      if (raw === undefined) return
      const saved = readHandoffTargetRecord(key(plan, kind), raw)
      if (!same(plan, saved.plan) || saved.plan.manifestHash !== plan.manifestHash)
        fail("Destination receipt belongs to another immutable handoff")
      if (
        saved.fact.purpose !==
        (kind === "prepared"
          ? "target-prepared"
          : kind === "activated"
            ? "target-activated"
            : kind === "difference"
              ? "target-difference"
              : kind === "preview-released"
                ? "target-preview-released"
                : "target-never-activate")
      )
        fail("Destination receipt has another native purpose")
      return saved
    }
    async function reserve(plan: Handoff.MachinePlan, manifestHash: string, signal: AbortSignal) {
      const bindings: Epochs.Binding[] = []
      for await (const member of Staging.members({
        handoffID: plan.handoffID,
        rootSessionID: plan.sessionID,
        scopeID: plan.sourceBinding.projectID,
        signal,
      })) {
        assertOwner(signal)
        const selected = binding(plan, member.session.id)
        await Epochs.reserve(selected, manifestHash, await Epochs.destinationPrior(selected))
        bindings.push(selected)
      }
      return bindings
    }
    async function receive(
      input: Input,
      plan: Handoff.MachinePlan,
      manifestHash: string,
      frozen: Extract<Handoff.Proof, { purpose: "source-frozen" }>,
      read: MemberResourceClient["handoffObject"],
    ) {
      const objects = await Objects.open(
        {
          orgID: plan.orgID,
          deploymentIncarnation: plan.deploymentIncarnation,
          role: "target",
          binding: binding(plan),
        },
        input.signal,
      )
      const receiver = Receive.open({
        manifestHash,
        signal: input.signal,
        cache: { store: objects.store, contains: objects.contains },
        read: ({ manifestHash, ...range }) =>
          read(
            {
              ...factBinding(plan),
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
      const root = await receiver.root()
      if (compatibilityHash(root.owners) !== frozen.compatibilityHash)
        fail("Destination reader contract differs from its frozen source fact")
      await Staging.receive({ handoffID: plan.handoffID, root, store: receiver.store, signal: input.signal })
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
      return { root, aggregate }
    }
    function contexts(input: Input, plan: Handoff.MachinePlan, manifestHash: string, retain: boolean) {
      return WorkspaceTarget.run(plan, input.resources, input.signal, () =>
        nativeContexts(input, plan, manifestHash, retain),
      )
    }
    async function nativeContexts(input: Input, plan: Handoff.MachinePlan, manifestHash: string, retain: boolean) {
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
        const moveHash =
          member.session.id === plan.sessionID && frozen?.purpose === "source-frozen"
            ? frozen.workspaceMoveReceiptHash
            : null
        if (selected.workspaceMoveReceiptHash !== undefined && selected.workspaceMoveReceiptHash !== moveHash)
          fail("Destination mapping conflicts with its frozen WorkspaceMove receipt")
        selected.workspaceMoveReceiptHash = moveHash
        const sourceHash =
          member.session.id === plan.sessionID && frozen?.purpose === "source-frozen"
            ? (frozen.workspaceSourceHash ?? null)
            : null
        if (selected.workspaceSourceHash !== undefined && selected.workspaceSourceHash !== sourceHash)
          fail("Destination mapping conflicts with its frozen Workspace source snapshot")
        selected.workspaceSourceHash = sourceHash
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
        await Epochs.reserve(reservation, manifestHash, await Epochs.destinationPrior(reservation))
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
        if (plan.cleanup) {
          const retired = (await receipt(plan, "retired")) ?? (await receipt(plan, "preview-released"))
          const move = await WorkspaceTarget.status(plan, input.resources, input.signal)
          const job = jobs.get(plan.handoffID)
          const hasEpoch =
            retired || move || job || (await receipt(plan, "prepared")) || (await receipt(plan, "difference"))
          const epoch = hasEpoch ? await Epochs.inspect(binding(plan)) : undefined
          if (epoch && (epoch.role !== "target" || epoch.manifestHash !== manifestHash))
            fail("Cleanup inspection has another original native epoch")
          if (retired && epoch?.phase !== "never_activate")
            fail("Native cleanup has no actual never-activate tombstone")
          const complete =
            !!retired && (!move || (!move.nativeRequested && ["cancelled", "retired"].includes(move.state)))
          assertOwner(input.signal)
          return Handoff.MachineExecution.parse({
            handoffID: plan.handoffID,
            requestID: plan.requestID,
            runtimeID: plan.runtimeID,
            operation: plan.operation,
            state: complete ? "complete" : job ? "working" : hasEpoch ? "blocked" : "idle",
            stage: complete ? retired.fact.purpose : hasEpoch ? "preparing" : "idle",
            revision: complete
              ? await Handoff.proofHash(retired.fact)
              : hash({
                  handoffID: plan.handoffID,
                  manifestHash,
                  phase: epoch?.phase,
                  state: move?.state,
                  nativeRequested: move?.nativeRequested,
                }),
            requirements: [],
            facts: complete ? [retired.fact] : [],
          })
        }
        const activated = await receipt(plan, "activated")
        const retired = (await receipt(plan, "retired")) ?? (await receipt(plan, "preview-released"))
        const observedDifference = await receipt(plan, "difference")
        const prepared = activated ?? retired ?? (await receipt(plan, "prepared")) ?? observedDifference
        const fact = prepared?.fact
        const job = jobs.get(plan.handoffID)
        if (job && (!same(plan, job.plan) || job.plan.manifestHash !== manifestHash))
          fail("Destination inspection belongs to another preparation")
        if (fact) {
          const epoch = await Epochs.inspect(binding(plan))
          if (
            epoch.role !== "target" ||
            epoch.manifestHash !== manifestHash ||
            epoch.phase !== (activated ? "activated" : retired ? "never_activate" : "prepared")
          )
            fail("Destination inspection has no matching permanent native outcome")
        }
        assertOwner(input.signal)
        const difference =
          observedDifference?.fact.purpose === "target-difference" ? observedDifference.fact.difference : undefined
        const page =
          difference && plan.expectedRevision
            ? await WorkspaceTarget.difference(plan, input.resources, input.signal)
            : undefined
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
          facts: fact
            ? [
                fact,
                ...(observedDifference && observedDifference.fact.purpose !== fact.purpose
                  ? [observedDifference.fact]
                  : []),
              ]
            : [],
          workspaceDifference: difference,
          differencePage: page,
        })
      },
      async preview(value: Input & { resources: Pick<MemberResourceClient, "handoffObject"> }): Promise<Handoff.Proof> {
        const input = snapshot(value),
          read = value.resources.handoffObject.bind(value.resources)
        const { plan, manifestHash, frozen } = await authorize(input, "preview-target")
        if (
          plan.workspacePlan?.mapping.kind !== "organization-native" ||
          closing.has(plan.handoffID) ||
          (await receipt(plan, "retired")) ||
          (await receipt(plan, "preview-released")) ||
          (await receipt(plan, "prepared"))
        )
          fail("Native preview requires its inactive original target")
        const previous = jobs.get(plan.handoffID)
        if (previous) {
          if (!same(plan, previous.plan) || previous.plan.operation !== plan.operation)
            fail("Destination already has different accepted work")
          return previous.promise
        }
        const abort = new AbortController()
        input.signal = AbortSignal.any([input.signal, abort.signal])
        const promise = (async () => {
          await receive(input, plan, manifestHash, frozen, read)
          await reserve(plan, manifestHash, input.signal)
          const summary = await WorkspaceTarget.preview(plan, input.resources, input.signal)
          const difference = Handoff.Difference.strip().parse({
            ...summary,
            mappingPlanRevision: plan.mappingPlanRevision,
          })
          const fact = Handoff.Proof.parse({
            ...factBinding(plan),
            purpose: "target-difference",
            manifestHash,
            difference,
          })
          assertOwner(input.signal)
          return Storage.transaction(
            async () => {
              if (
                closing.has(plan.handoffID) ||
                (await receipt(plan, "retired")) ||
                (await receipt(plan, "preview-released")) ||
                (await receipt(plan, "prepared"))
              )
                fail("Native target closed during its accepted preview")
              await Storage.write(key(plan, "difference"), Receipt.parse({ version: 2, plan, fact }))
              return fact
            },
            {
              commitGuard() {
                assertOwner(input.signal)
                if (closing.has(plan.handoffID)) fail("Native preview was cancelled before publication")
              },
            },
          )
        })()
        jobs.set(plan.handoffID, { plan, abort, promise })
        try {
          return await promise
        } finally {
          if (jobs.get(plan.handoffID)?.promise === promise) jobs.delete(plan.handoffID)
        }
      },
      async prepare(value: Input & { resources: Pick<MemberResourceClient, "handoffObject"> }): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const read = value.resources.handoffObject.bind(value.resources)
        const { plan, manifestHash, frozen } = await authorize(input, "prepare-target")
        if (
          closing.has(plan.handoffID) ||
          (await receipt(plan, "retired")) ||
          (await receipt(plan, "preview-released"))
        )
          fail("Destination preparation was permanently closed")
        const previous = jobs.get(plan.handoffID)
        if (previous) {
          if (
            !same(plan, previous.plan) ||
            previous.plan.operation !== plan.operation ||
            previous.plan.manifestHash !== manifestHash ||
            previous.plan.connectionEpoch !== plan.connectionEpoch ||
            previous.plan.commandSeq !== plan.commandSeq
          )
            fail("Destination preparation is already using another immutable handoff")
          return previous.promise
        }
        const abort = new AbortController()
        input.signal = AbortSignal.any([input.signal, abort.signal])
        const promise = (async () => {
          const { root, aggregate } = await receive(input, plan, manifestHash, frozen, read)
          if (frozen.fileClosureHash !== null)
            await WorkspaceTarget.run(plan, input.resources, input.signal, () =>
              Files.prepareTarget({
                binding: binding(plan),
                expectedReceiptHash: frozen.fileClosureHash!,
                signal: input.signal,
                nativeMode: plan.workspacePlan?.mapping.kind === "organization-native" ? "existing" : undefined,
              }),
            )
          const prepared = await contexts(input, plan, manifestHash, false)
          const move =
            plan.workspacePlan?.mapping.kind === "organization-native"
              ? await WorkspaceTarget.status(plan, input.resources, input.signal)
              : undefined
          if (move && (!("nativeReceipt" in move) || !move.nativeReceipt))
            fail("Native target preparation has no complete original Move receipt")
          const fact = Handoff.Proof.parse({
            ...factBinding(plan),
            purpose: "target-prepared",
            manifestHash,
            compatibilityHash: compatibilityHash(root.owners),
            convertedHash: prepared.convertedHash,
            closureHash: aggregate.digest,
            fileClosureHash: frozen.fileClosureHash,
            workspaceMoveReceiptHash: frozen.workspaceMoveReceiptHash,
            ...(frozen.workspaceSourceHash === undefined ? {} : { workspaceSourceHash: frozen.workspaceSourceHash }),
            paused: true,
            ...(move && "nativeReceipt" in move && move.nativeReceipt
              ? {
                  workspaceNativeReceiptHash: WorkspaceMove.nativeReceiptHash(move.nativeReceipt),
                  workspaceDifferenceHash: move.nativeReceipt.acceptedDiffHash,
                }
              : {}),
          })
          assertOwner(input.signal)
          return Storage.transaction(
            async () => {
              const existing = await receipt(plan, "prepared")
              if (closing.has(plan.handoffID)) fail("Destination preparation was cancelled before publication")
              if (existing && JSON.stringify(existing.fact) !== JSON.stringify(fact))
                fail("Destination preparation cannot change its immutable mapping")
              if (existing) return existing.fact
              await Storage.write(key(plan, "prepared"), Receipt.parse({ version: 2, plan, fact }))
              return fact
            },
            {
              commitGuard() {
                assertOwner(input.signal)
              },
            },
          )
        })()
        jobs.set(plan.handoffID, { plan, abort, promise })
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
            if (plan.workspacePlan?.mapping.kind === "organization-native")
              await WorkspaceTarget.release(plan, input.resources, input.signal, "activated")
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
                await Storage.write(key(plan, "activated"), Receipt.parse({ version: 2, plan, fact }))
                assertOwner(input.signal)
              },
            })
          if (preparedFact.fileClosureHash !== null)
            await WorkspaceTarget.run(plan, input.resources, input.signal, () =>
              Files.withTargetPublication({ handoffID: plan.handoffID, signal: input.signal }, publish),
            )
          else await publish()
          assertOwner(input.signal)
          if (plan.workspacePlan?.mapping.kind === "organization-native")
            await WorkspaceTarget.release(plan, input.resources, input.signal, "activated")
          return fact
        })
      },
      async retire(value: Input): Promise<Handoff.Proof> {
        const input = snapshot(value)
        const { plan, manifestHash } = await authorize(input, "retire-target")
        if (plan.workspacePlan?.mapping.kind === "organization-native") {
          closing.add(plan.handoffID)
          const previous = jobs.get(plan.handoffID)
          if (previous) {
            if (!same(plan, previous.plan) || previous.plan.manifestHash !== manifestHash)
              fail("Native retirement has another accepted preparation")
            previous.abort.abort(new Error("Original native target preparation cancelled"))
            await previous.promise.catch(() => {})
          }
          await Staging.verify(plan.handoffID, input.signal)
          const saved = await receipt(plan, "prepared")
          const retired = (await receipt(plan, "retired")) ?? (await receipt(plan, "preview-released"))
          const knownPrepared = !!(
            saved &&
            saved.fact.purpose === "target-prepared" &&
            plan.preparedHash === (await Handoff.proofHash(saved.fact))
          )
          const bindings = await reserve(plan, manifestHash, input.signal)
          await Storage.transaction(
            async () => {
              if (await receipt(plan, "activated")) fail("An activated native destination cannot be retired")
              for (const selected of bindings) await Epochs.neverActivate(selected, manifestHash)
            },
            { commitGuard: () => assertOwner(input.signal) },
          )
          await WorkspaceTarget.release(plan, input.resources, input.signal, knownPrepared ? "retired" : "cancelled")
          if (retired) return retired.fact
          const fact = Handoff.Proof.parse({
            ...factBinding(plan),
            manifestHash,
            tombstonePersisted: true,
            ...(knownPrepared
              ? { purpose: "target-never-activate", preparedHash: plan.preparedHash }
              : { purpose: "target-preview-released", diffHash: plan.workspacePlan.difference?.diffHash ?? null }),
          })
          return Storage.transaction(
            async () => {
              if (await receipt(plan, "activated")) fail("An activated native destination cannot be retired")
              await Storage.write(
                key(plan, knownPrepared ? "retired" : "preview-released"),
                Receipt.parse({ version: 2, plan, fact }),
              )
              return fact
            },
            { commitGuard: () => assertOwner(input.signal) },
          )
        }
        const saved = await receipt(plan, "prepared")
        if (
          !saved ||
          saved.fact.purpose !== "target-prepared" ||
          plan.preparedHash !== (await Handoff.proofHash(saved.fact)) ||
          jobs.has(plan.handoffID)
        )
          fail("Destination retirement requires its exact completed preparation")
        await Staging.verify(plan.handoffID, input.signal)
        const retired = await receipt(plan, "retired")
        if (retired) return retired.fact
        const prepared = await contexts(input, plan, manifestHash, true)
        return Storage.transaction(
          async () => {
            if (await receipt(plan, "activated")) fail("An activated destination cannot be retired")
            const previous = await receipt(plan, "retired")
            if (previous) return previous.fact
            for (const member of prepared.bindings) {
              assertOwner(input.signal)
              await Epochs.neverActivate(member, manifestHash)
            }
            const fact = Handoff.Proof.parse({
              ...factBinding(plan),
              purpose: "target-never-activate",
              manifestHash,
              preparedHash: plan.preparedHash,
              tombstonePersisted: true,
            })
            await Storage.write(key(plan, "retired"), Receipt.parse({ version: 2, plan, fact }))
            assertOwner(input.signal)
            return fact
          },
          { commitGuard: () => assertOwner(input.signal) },
        )
      },
    }
  }
}
