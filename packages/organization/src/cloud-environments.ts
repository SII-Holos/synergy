import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import { StorageRecovery } from "@ericsanchezok/synergy-harness/storage/recovery"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { registerEnvironmentMigrations } from "@ericsanchezok/synergy-harness/environment/migration"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { OrganizationCloudExecutionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationExecutionGrants as Grants, type ExecutionGrants } from "./execution-grants"
import { OrganizationCloud } from "./cloud"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationError, fail } from "./error"
import { OrganizationServiceMaintenance } from "./service-maintenance"

const hostOwner = "organization-environment"
const filesHostOwner = "organization-workspace-files"
const FilesBinding = z.strictObject({
  version: z.literal(1),
  kind: z.literal("workspace-files"),
  grantID: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
  scopeID: z.string().min(1).max(256),
  workspaceID: z.string().min(1).max(256),
  workspaceGeneration: z.number().int().positive().safe(),
  target: Environment.Target,
  mount: WorkspaceProtocol.Reference,
  path: z.string().min(1).max(4096),
  requestID: z.string().uuid(),
})
function filesBinding(value: string) {
  if (Buffer.byteLength(value) > 16384)
    fail("PROTOCOL_MISMATCH", "Workspace file ownership exceeds its bounded selector")
  const binding = FilesBinding.parse(JSON.parse(value))
  if (JSON.stringify(binding) !== value) fail("PROTOCOL_MISMATCH", "Workspace file ownership is not canonical")
  return binding
}
type Host = Extract<EnvironmentOrigin.Info, { kind: "host" }>
const state = RuntimeContext.state(() => ({
  host: undefined as ReturnType<typeof EnvironmentOrigin.registerHost> | undefined,
  filesHost: undefined as ReturnType<typeof EnvironmentOrigin.registerHost> | undefined,
  claimed: false,
  recovering: false,
  recovered: false,
  mutation: undefined as ((origin: Readonly<Host>) => Promise<void>) | undefined,
}))
const authority = RuntimeContext.createAsyncContext<ReturnType<typeof Grants.environmentAuthority> | undefined>()
const filesAuthority = RuntimeContext.createAsyncContext<
  | {
      invocationID: string
      scopeID: string
      target: Environment.Target
      assert(): void
      recheck(): Promise<void>
    }
  | undefined
>()
const completion = RuntimeContext.createAsyncContext<{ info: EnvironmentExecution.Info; assert(): void }>()
const preparationCompletion = RuntimeContext.createAsyncContext<{
  preparation: EnvironmentExecution.RetainedPreparation
  scopeID: string
  assert(): void
}>()
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export function registerOrganizationCloudEnvironments() {
  RuntimeContext.assertCompositionOpen("Organization Environment execution")
  if (state().host) throw new Error("Organization Environment execution is already registered")
  const owner = WorkspaceContent.captureOwner()
  state().host = EnvironmentOrigin.registerHost(hostOwner, {
    async admission(origin, target) {
      owner()
      const frame = authority.getStore()
      if (!frame || frame.kind !== "dispatch")
        fail("PERMISSION_DENIED", "Environment admission has no original live authority")
      const operation = Protocol.Request.parse(frame.request).proof.operation
      let invocationID: string
      if (operation.action === "resolve") {
        const bindingDigest = digest({
          grant: frame.grant,
          nativeOperationID: operation.nativeOperationID,
          origin: operation.origin,
          capability: operation.capability,
          workspace: operation.workspace,
        })
        invocationID = Protocol.hostInvocation({
          version: 1,
          kind: "admission",
          grantID: frame.grant.grantID,
          retentionGeneration: frame.grant.retention.generation,
          leaseID: "org_admission_" + bindingDigest,
          bindingDigest,
        })
      } else if (
        ["start", "prepare-inputs", "prepare-sandbox"].includes(operation.action) &&
        "reference" in operation
      ) {
        const binding = Protocol.readHostInvocation(origin.invocationID)
        if (binding.kind !== "execution" || !same(binding.reference, operation.reference))
          fail("PERMISSION_DENIED", "Environment preparation has another original native binding")
        invocationID = (
          await Protocol.operationIdentity(
            operation.reference,
            operation.reference.nativeOperationID,
            binding.nativeOrigin,
          )
        ).invocationID
      } else fail("PERMISSION_DENIED", "Retained Environment operations cannot acquire new admission")
      if (
        origin.owner !== hostOwner ||
        origin.invocationID !== invocationID ||
        target.scopeID !== OrganizationCloud.scopeID(frame.grant.orgID, frame.grant.projectID) ||
        target.environmentID !== frame.grant.selection.infrastructure.environment?.environmentID
      )
        fail("PERMISSION_DENIED", "Environment admission changed its original physical selection")
      await frame.recheck()
      owner()
      frame.assert()
    },
    async mutation(origin) {
      owner()
      if (state().recovering) {
        const binding = Protocol.readHostInvocation(origin.invocationID)
        if (binding.kind !== "execution")
          fail("PERMISSION_DENIED", "Cold Environment mutation requires an original execution")
        const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(binding.grantID))
        if (!grant || grant.state !== "bound" || binding.retentionGeneration > grant.retention.generation)
          fail("PERMISSION_DENIED", "Cold Environment mutation lost its original retained grant")
        const info = await EnvironmentExecution.get(
          binding.operationID,
          OrganizationCloud.scopeID(grant.orgID, grant.projectID),
        )
        const selected = grant.selection.infrastructure.environment
        if (
          origin.owner !== hostOwner ||
          !same(info.origin, origin) ||
          binding.operationID !== "org_env_" + binding.bindingDigest ||
          info.target.environmentID !== selected?.environmentID
        )
          fail("PERMISSION_DENIED", "Cold Environment mutation has another original native operation")
        const environment = await Environment.get(info.target.environmentID, info.scopeID)
        if (!Environment.sameTarget(info.target, Environment.targetOf(environment)))
          fail("PERMISSION_DENIED", "Cold Environment mutation has another actual target")
        owner()
        return
      }
      const validate = state().mutation
      if (!validate) fail("PERMISSION_DENIED", "Environment mutation has no installed original owner")
      await validate(origin)
      owner()
    },
  })
  state().filesHost = EnvironmentOrigin.registerHost(filesHostOwner, {
    async admission(origin, target) {
      owner()
      const frame = filesAuthority.getStore()
      if (
        !frame ||
        origin.owner !== filesHostOwner ||
        origin.invocationID !== frame.invocationID ||
        target.scopeID !== frame.scopeID ||
        target.environmentID !== frame.target.environmentID
      )
        fail("PERMISSION_DENIED", "Workspace file admission has no original live Workspace authority")
      frame.assert()
      await frame.recheck()
      owner()
      frame.assert()
    },
    async mutation() {
      fail("PERMISSION_DENIED", "Workspace file admission cannot authorize execution mutation")
    },
  })
  registerEnvironmentMigrations()
  Environment.registerRecovery({ allocation: "inspect-only" })
  EnvironmentExecution.registerRecovery()
  WorkspaceMounts.register()
  WorkspaceOperations.register()
  const primary = Storage.current().store
  StorageMutationGuard.register("organization-environment-authority", async () => {
    const current = authority.getStore()
    const files = filesAuthority.getStore()
    if (!current && !files) return
    if (Storage.current().store !== primary) fail("PERMISSION_DENIED", "Environment authority changed its native Store")
    if (current) {
      current.assert()
      await current.recheck()
      current.assert()
    }
    if (files) {
      files.assert()
      await files.recheck()
      files.assert()
    }
  })
  return Object.freeze({
    async recover() {
      owner()
      if (state().claimed || state().recovering || state().recovered)
        fail("PERMISSION_DENIED", "Environment startup recovery already has its original owner")
      state().recovering = true
      try {
        await StorageRecovery.recoverOwners()
        owner()
        state().recovered = true
      } finally {
        state().recovering = false
      }
    },
  })
}

interface AcceptedOperation {
  nativeID: string
  origin: z.infer<ReturnType<typeof z.json>>
  physicalID: string
  invocationID: string
  digest: string
  completed: boolean
  sandboxID?: string
  finishing?: Promise<EnvironmentExecution.Info>
}
interface PreparedInput {
  digest: string
  promise: Promise<ExecutionProtocol.PreparedInputs>
  released: boolean
}
interface SandboxPreparation {
  promise: Promise<ExecutionProtocol.Sandbox>
  id?: string
  released: boolean
}
interface RetiringAdmission {
  grantID: string
  resources: EnvironmentResources.Resolved
  tail: OrganizationServiceMaintenance.Tail
}
interface PendingAdmissionCleanup {
  grantID: string
  cleanup: Readonly<Pick<EnvironmentResources.Resolved, "release">>
  tail: OrganizationServiceMaintenance.Tail
}
interface Lease {
  reference: Protocol.Reference
  requestDigest: string
  origin: z.infer<ReturnType<typeof z.json>>
  admissionClosing: boolean
  admissionAbort: AbortController
  calls: Set<Promise<unknown>>
  resources: EnvironmentResources.Resolved
  tail: OrganizationServiceMaintenance.Tail
  admissionClosed: boolean
  tailClosed: boolean
  release?: Promise<void>
  operations: Map<string, AcceptedOperation>
  inputs: Map<string, PreparedInput>
  sandboxes: Set<string>
  releasedSandboxes: Set<string>
  sandboxPreparations: Map<string, SandboxPreparation>
  preparation?: Promise<EnvironmentExecution.Preparation>
  prepared?: EnvironmentExecution.Preparation
  preparationReleased: boolean
}
interface ColdBlocker {
  grantID: string
  generation: number
  scopeID: string
  operationID?: string
  useID?: string
  preparation?: Environment.Use
  reason: string
}

export function createOrganizationCloudEnvironments(options: { grants: ExecutionGrants }) {
  const runtime = RuntimeContext.current(),
    primary = runtime.storage
  const nativeOwner = WorkspaceContent.captureOwner()
  const registered = state().host
  if (!registered || !primary) throw new Error("Organization Environment execution requires its installed native owner")
  const host = registered
  const filesHost = state().filesHost
  if (!filesHost) throw new Error("Organization Workspace files require their installed native owner")
  if (state().claimed) throw new Error("Organization Environment execution already has its service owner")
  state().claimed = true
  const leases = new Map<string, Lease>()
  const retiring = new Map<string, RetiringAdmission>()
  const admissionCleanups = new Map<string, PendingAdmissionCleanup>()
  const unresolvedAdmissions = new Map<string, { grantID: string; tail: OrganizationServiceMaintenance.Tail }>()
  const admissions = new Map<string, { digest: string; promise: Promise<Lease> }>()
  const cold = new Map<string, ColdBlocker>()
  const active = new Map<string, number>()
  let unknown: string | undefined
  let inventoryFailure: string | undefined
  let accepting = false
  let closing: Promise<void> | undefined
  let coldTail: OrganizationServiceMaintenance.Tail | undefined
  const owner = () => {
    nativeOwner()
    const current = Storage.current()
    if (
      RuntimeContext.current() !== runtime ||
      runtime.storage !== primary ||
      current.store !== primary.store ||
      current.artifactDirectory !== primary.artifactDirectory ||
      current.artifactObjects !== primary.artifactObjects
    )
      fail("PERMISSION_DENIED", "Environment execution lost its actual service primary")
  }
  state().mutation = async (origin) => {
    owner()
    const frame = authority.getStore()
    if (frame) {
      if (frame.kind !== "dispatch") fail("PERMISSION_DENIED", "Retained inspection cannot admit a new native mutation")
      const operation = Protocol.Request.parse(frame.request).proof.operation
      if (!("reference" in operation) || !("id" in operation))
        fail("PERMISSION_DENIED", "Environment mutation requires its original operation")
      const lease = selected(operation.reference)
      const identity = await Protocol.operationIdentity(
        lease.reference,
        lease.reference.nativeOperationID,
        lease.origin,
      )
      if (origin.owner !== hostOwner || origin.invocationID !== identity.invocationID)
        fail("PERMISSION_DENIED", "Environment mutation belongs to another native operation")
      await frame.recheck()
      frame.assert()
      return
    }
    const prepared = preparationCompletion.getStore()
    if (prepared) {
      prepared.assert()
      if (!same(prepared.preparation.origin, origin))
        fail("PERMISSION_DENIED", "Preparation cleanup has another original native origin")
      await Environment.assertTarget(prepared.preparation.target, prepared.scopeID)
      prepared.assert()
      return
    }
    const original = completion.getStore()
    if (!original || !same(original.info.origin, origin))
      fail("PERMISSION_DENIED", "Environment completion has no exact original native owner")
    original.assert()
    const info = await EnvironmentExecution.get(original.info.id, original.info.scopeID)
    if (
      info.digest !== original.info.digest ||
      !same(info.origin, original.info.origin) ||
      !Environment.sameTarget(info.target, original.info.target)
    )
      fail("PERMISSION_DENIED", "Environment completion changed its original physical operation")
    original.assert()
  }
  const withoutAuthority = <T>(body: () => Promise<T>) => authority.run(undefined, body)
  const marked = async <T>(grantID: string, body: () => Promise<T>) => {
    active.set(grantID, (active.get(grantID) ?? 0) + 1)
    try {
      return await body()
    } finally {
      const remaining = (active.get(grantID) ?? 1) - 1
      if (remaining) active.set(grantID, remaining)
      else active.delete(grantID)
    }
  }
  const tracked = async <T>(lease: Lease, body: () => Promise<T>) => {
    const pending = body()
    lease.calls.add(pending)
    try {
      return await pending
    } finally {
      lease.calls.delete(pending)
    }
  }
  const hasPreparations = (lease: Lease) =>
    (lease.preparation !== undefined && !lease.preparationReleased) ||
    [...lease.inputs.values()].some((input) => !input.released) ||
    [...lease.sandboxPreparations.values()].some((preparation) => !preparation.released)
  function selected(reference: Protocol.Reference) {
    owner()
    const lease = leases.get(reference.leaseID)
    if (!lease || !same(lease.reference, reference))
      fail("PERMISSION_DENIED", "Environment operation has no original live admission")
    return lease
  }
  async function actual(
    info: EnvironmentExecution.Info,
    reference: Protocol.Reference,
    invocationID: string,
    expectedDigest: string,
  ) {
    owner()
    const target = Environment.Target.parse(reference.target)
    const mount = WorkspaceProtocol.Reference.parse(reference.mount)
    if (
      info.scopeID !== reference.serviceScopeID ||
      info.origin.kind !== "host" ||
      info.origin.owner !== hostOwner ||
      info.origin.invocationID !== invocationID ||
      info.digest !== expectedDigest ||
      !Environment.sameTarget(info.target, target) ||
      !same(info.workspaces, [mount])
    )
      fail("PROTOCOL_MISMATCH", "Environment receipt has another original physical operation")
    return info
  }
  async function inspectOriginal(
    reference: Protocol.Reference,
    nativeID: string,
    origin: z.infer<ReturnType<typeof z.json>>,
    expectedDigest: string,
  ) {
    owner()
    const identity = await Protocol.operationIdentity(reference, nativeID, origin)
    const info = await EnvironmentExecution.get(identity.operationID, reference.serviceScopeID).catch(
      (error: unknown) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      },
    )
    return info && actual(info, reference, identity.invocationID, expectedDigest)
  }
  function closeTail(lease: Lease) {
    if (
      lease.tailClosed ||
      !lease.admissionClosed ||
      hasPreparations(lease) ||
      lease.sandboxes.size ||
      [...lease.operations.values()].some((operation) => !operation.completed)
    )
      return
    lease.tail.close()
    lease.tailClosed = true
  }
  function withCompletion<T>(
    info: EnvironmentExecution.Info,
    tail: OrganizationServiceMaintenance.Tail,
    body: () => Promise<T>,
  ) {
    owner()
    let open = true
    const assert = () => {
      owner()
      if (!open) fail("PERMISSION_DENIED", "The original Environment completion callback has ended")
    }
    return withoutAuthority(() =>
      tail.run(() =>
        completion.run({ info, assert }, async () => {
          try {
            return await body()
          } finally {
            open = false
          }
        }),
      ),
    )
  }
  function prepare(lease: Lease, markEffect: () => void) {
    if (lease.preparationReleased) fail("PERMISSION_DENIED", "Original Environment preparation has permanently ended")
    lease.preparation ??= (async () => {
      const identity = await Protocol.operationIdentity(
        lease.reference,
        lease.reference.nativeOperationID,
        lease.origin,
      )
      if (lease.admissionClosing || lease.admissionClosed)
        fail("PERMISSION_DENIED", "Original Environment admission is retiring")
      markEffect()
      const prepared = await EnvironmentExecution.prepareResources({
        id: identity.operationID,
        scopeID: lease.reference.serviceScopeID,
        target: Environment.Target.parse(lease.reference.target),
        origin: host.capture(identity.invocationID),
        workspaces: [WorkspaceProtocol.Reference.parse(lease.reference.mount)],
        signal: lease.admissionAbort.signal,
      })
      owner()
      if (
        prepared.id !== identity.operationID ||
        prepared.origin.kind !== "host" ||
        prepared.origin.owner !== hostOwner ||
        prepared.origin.invocationID !== identity.invocationID ||
        !Environment.sameTarget(prepared.target, Environment.Target.parse(lease.reference.target))
      )
        fail("PROTOCOL_MISMATCH", "Environment preparation has another actual native owner")
      lease.prepared = prepared
      return prepared
    })()
    return lease.preparation
  }
  async function retainedPreparation(reference: Protocol.Reference, origin: z.infer<ReturnType<typeof z.json>>) {
    owner()
    const identity = await Protocol.operationIdentity(reference, reference.nativeOperationID, origin)
    for await (const use of Environment.useEntries(reference.environmentID)) {
      if (
        use.ownership.kind !== "execution-preparation" ||
        use.ownership.scopeID !== reference.serviceScopeID ||
        use.ownership.operationID !== identity.operationID
      )
        continue
      if (
        use.ownership.origin.kind !== "host" ||
        use.ownership.origin.owner !== hostOwner ||
        use.ownership.origin.invocationID !== identity.invocationID ||
        !Environment.sameTarget(use.target, Environment.Target.parse(reference.target))
      )
        fail("PROTOCOL_MISMATCH", "Retained preparation changed its actual original Use")
      return EnvironmentExecution.retainedPreparation(use)
    }
  }
  async function withPreparationCompletion<T>(
    preparation: EnvironmentExecution.RetainedPreparation,
    reference: Protocol.Reference,
    origin: z.infer<ReturnType<typeof z.json>>,
    tail: OrganizationServiceMaintenance.Tail,
    body: () => Promise<T>,
  ) {
    const identity = await Protocol.operationIdentity(reference, reference.nativeOperationID, origin)
    owner()
    if (
      preparation.id !== identity.operationID ||
      preparation.origin.kind !== "host" ||
      preparation.origin.owner !== hostOwner ||
      preparation.origin.invocationID !== identity.invocationID ||
      !Environment.sameTarget(preparation.target, Environment.Target.parse(reference.target))
    )
      fail("PROTOCOL_MISMATCH", "Preparation completion has another original native capability")
    let open = true
    const assert = () => {
      owner()
      if (!open) fail("PERMISSION_DENIED", "Original preparation completion callback has ended")
    }
    return withoutAuthority(() =>
      tail.run(() =>
        preparationCompletion.run({ preparation, scopeID: reference.serviceScopeID, assert }, async () => {
          try {
            return await body()
          } finally {
            open = false
          }
        }),
      ),
    )
  }
  async function releasePreparation(lease: Lease) {
    owner()
    if (!lease.preparation || lease.preparationReleased) return
    await Promise.allSettled([lease.preparation])
    const preparation = lease.prepared ?? (await retainedPreparation(lease.reference, lease.origin))
    if (!preparation)
      fail("RESOURCE_UNAVAILABLE", "Original preparation has no inspectable native Use or retained capability")
    await withPreparationCompletion(preparation, lease.reference, lease.origin, lease.tail, () => preparation.release())
    lease.preparationReleased = true
    for (const input of lease.inputs.values()) input.released = true
    for (const prepared of lease.sandboxPreparations.values()) prepared.released = true
    for (const id of lease.sandboxes) lease.releasedSandboxes.add(id)
    lease.sandboxes.clear()
  }
  async function releaseAdmission(lease: Lease) {
    owner()
    if (lease.admissionClosed) return
    if (lease.release) return lease.release
    lease.admissionClosing = true
    lease.admissionAbort.abort(new Error("Original Environment admission is retiring"))
    const pending = withoutAuthority(() =>
      lease.tail.run(async () => {
        await Promise.allSettled([...lease.calls])
        if (![...lease.operations.values()].some((operation) => !operation.completed)) await releasePreparation(lease)
        await lease.resources.release()
        owner()
        lease.admissionClosed = true
      }),
    )
    lease.release = pending
    try {
      await pending
    } finally {
      if (lease.release === pending) lease.release = undefined
    }
    closeTail(lease)
  }
  async function finish(
    lease: Lease,
    operation: AcceptedOperation,
    cancel = false,
  ): Promise<EnvironmentExecution.Info> {
    owner()
    const prepared = lease.inputs.get(operation.nativeID)
    const settled = () =>
      operation.completed &&
      (!lease.preparation || lease.preparationReleased) &&
      (!prepared || prepared.released) &&
      (!operation.sandboxID || lease.releasedSandboxes.has(operation.sandboxID))
    const committed = async () => {
      const current = await EnvironmentExecution.get(operation.physicalID, lease.reference.serviceScopeID)
      await actual(current, lease.reference, operation.invocationID, operation.digest)
      if (current.state !== "completed")
        fail("PROTOCOL_MISMATCH", "Original completion has no committed native receipt")
      return current
    }
    let observed = await EnvironmentExecution.get(operation.physicalID, lease.reference.serviceScopeID)
    await actual(observed, lease.reference, operation.invocationID, operation.digest)
    if (settled()) return committed()
    if (cancel && !operation.completed) {
      await withCompletion(observed, lease.tail, () =>
        EnvironmentExecution.cancel(operation.physicalID, lease.reference.serviceScopeID),
      )
      observed = await EnvironmentExecution.get(operation.physicalID, lease.reference.serviceScopeID)
      await actual(observed, lease.reference, operation.invocationID, operation.digest)
    }
    if (settled()) return committed()
    if (operation.finishing) return operation.finishing
    const pending = (async () => {
      const completed = await withCompletion(observed, lease.tail, async () => {
        for (;;) {
          owner()
          const info = await EnvironmentExecution.reconcile(operation.physicalID, lease.reference.serviceScopeID)
          await actual(info, lease.reference, operation.invocationID, operation.digest)
          if (info.state === "completed") return info
          if (["exited", "unsaved", "saved"].includes(info.state)) {
            const completed = await EnvironmentExecution.complete(info.id, info.scopeID)
            await actual(completed, lease.reference, operation.invocationID, operation.digest)
            return completed
          }
          if (info.state === "unknown")
            fail("RESOURCE_UNAVAILABLE", "The original Environment process outcome is unknown")
          const executor = runtimeOf(lease).executor
          if (info.status && executor.waitForChange) await executor.waitForChange(info.id, info.status, 250)
          else await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      })
      operation.completed = true
      await releasePreparation(lease)
      return completed
    })()
    operation.finishing = pending
    try {
      return await pending
    } finally {
      if (operation.finishing === pending) operation.finishing = undefined
      closeTail(lease)
    }
  }
  async function readBlockers(full = false) {
    owner()
    await Storage.snapshot(async () => {
      const next = new Map<string, ColdBlocker>()
      const canonicalActive = new Set<string>()
      const ownedActive = new Set<string>()
      let unresolved: string | undefined
      const retained = async (
        binding: Protocol.HostBinding,
        environment: Environment.Info,
        reason: string,
        useID?: string,
        blocking = true,
        preparation?: Environment.Use,
      ) => {
        const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(binding.grantID))
        if (
          !grant ||
          grant.state !== "bound" ||
          binding.retentionGeneration > grant.retention.generation ||
          grant.selection.infrastructure.environment?.environmentID !== environment.id ||
          OrganizationCloud.scopeID(grant.orgID, grant.projectID) !== environment.scopeID ||
          (binding.kind === "execution"
            ? binding.operationID !== "org_env_" + binding.bindingDigest
            : binding.leaseID !== "org_admission_" + binding.bindingDigest)
        ) {
          unresolved = "A native Environment fact has no original retained grant"
          return
        }
        if (binding.kind === "execution") {
          Grants.assertRetainedEnvironmentReference(grant, binding.reference)
          const identity = await Protocol.operationIdentity(
            binding.reference,
            binding.reference.nativeOperationID,
            binding.nativeOrigin,
          )
          if (
            identity.operationID !== binding.operationID ||
            identity.invocationID !== Protocol.hostInvocation(binding) ||
            binding.reference.serviceScopeID !== environment.scopeID ||
            binding.reference.environmentID !== environment.id
          ) {
            unresolved = "A native Environment fact changed its original immutable operation mapping"
            return
          }
        }
        if (!blocking) return
        next.set(
          JSON.stringify([
            environment.scopeID,
            environment.id,
            useID ? "use" : "operation",
            useID ?? (binding.kind === "execution" ? binding.operationID : binding.leaseID),
          ]),
          {
            grantID: binding.grantID,
            generation: binding.retentionGeneration,
            scopeID: environment.scopeID,
            reason,
            useID,
            operationID: binding.kind === "execution" && !preparation ? binding.operationID : undefined,
            preparation,
          },
        )
      }
      const located = new Map<string, Environment.Info>()
      for await (const { environment } of OrganizationCloud.environmentEntries())
        located.set(environment.id, environment)
      const environments = new Map<string, Environment.Info>()
      const nativeEnvironments = full ? Environment.entries() : located.values()
      for await (const environment of nativeEnvironments) {
        environments.set(environment.id, environment)
        const locator = located.get(environment.id)
        if (!locator || locator.scopeID !== environment.scopeID)
          unresolved = "A native Environment has no original organization locator"
        if (!["idle", "ready"].includes(environment.state))
          unresolved = "An Environment allocation requires its original native reconciliation"
      }
      for (const [id] of located)
        if (!environments.has(id)) unresolved = "An organization Environment locator has no original native owner"
      const executions = full
        ? EnvironmentExecution.entries()
        : (async function* () {
            for (const environment of environments.values())
              yield* EnvironmentExecution.environmentEntries(environment.id)
          })()
      for await (const info of executions) {
        if (info.state !== "completed") canonicalActive.add(JSON.stringify([info.scopeID, info.id]))
        const environment = environments.get(info.target.environmentID)
        if (!environment || !located.has(environment.id)) {
          unresolved = "An Environment operation has no original native Environment and locator"
          continue
        }
        if (info.origin.kind !== "host" || info.origin.owner !== hostOwner) {
          unresolved = "An active Environment operation has unknown service ownership"
          continue
        }
        const binding = Protocol.readHostInvocation(info.origin.invocationID)
        if (binding.kind !== "execution" || binding.operationID !== info.id || info.scopeID !== environment.scopeID) {
          unresolved = "An active Environment operation has another canonical binding"
          continue
        }
        if (
          info.state !== "completed" &&
          (environment.state !== "ready" || !Environment.sameTarget(info.target, Environment.targetOf(environment)))
        ) {
          unresolved = "An active Environment operation has another original native target"
          continue
        }
        await retained(binding, environment, "execution", undefined, info.state !== "completed")
      }
      if (full) {
        const indexed = new Set<string>()
        for (const environment of environments.values())
          for await (const info of EnvironmentExecution.environmentEntries(environment.id))
            indexed.add(JSON.stringify([info.scopeID, info.id]))
        if (indexed.size !== canonicalActive.size || [...canonicalActive].some((id) => !indexed.has(id)))
          unresolved = "Native execution coverage differs from its original unfinished records"
      }
      for await (const use of Environment.useEntries()) {
        const inspected = await Environment.inspectUse(use)
        if (use.ownership.kind === "execution")
          ownedActive.add(JSON.stringify([use.ownership.scopeID, use.ownership.operationID]))
        owner()
        if (!inspected?.origin) {
          if (use.ownership.kind === "workspace-mount") {
            const workspace = await WorkspaceCatalog.get(use.ownership.workspaceID, use.ownership.scopeID)
            if (workspace.activeMount?.state === "active") continue
          }
          unresolved = "An Environment Use has no settled grant or permanent mount owner"
          continue
        }
        if (inspected.origin.kind === "host" && inspected.origin.owner === filesHostOwner) {
          const binding = filesBinding(inspected.origin.invocationID)
          const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(binding.grantID))
          const environment = environments.get(use.target.environmentID)
          const selected = grant?.selection.infrastructure.workspace
          if (
            !grant ||
            grant.state !== "bound" ||
            binding.generation > grant.retention.generation ||
            binding.scopeID !== OrganizationCloud.scopeID(grant.orgID, grant.projectID) ||
            selected?.workspaceID !== binding.workspaceID ||
            !environment ||
            environment.scopeID !== binding.scopeID ||
            !Environment.sameTarget(use.target, binding.target) ||
            environment.state !== "ready" ||
            !Environment.sameTarget(Environment.targetOf(environment), use.target) ||
            use.kind !== "admission"
          ) {
            unresolved = "A Workspace file Use has another original grant or native target"
            continue
          }
          const workspace = await WorkspaceCatalog.get(binding.workspaceID, binding.scopeID)
          await OrganizationCloud.assertInfrastructure(grant.orgID, grant.projectID, {
            workspace: selected,
            environment: null,
          })
          if (
            workspace.binding.generation !== binding.workspaceGeneration ||
            workspace.activeMount?.state !== "active" ||
            workspace.activeMount.path !== binding.path ||
            !Environment.sameTarget(workspace.activeMount.target, binding.target) ||
            !same(WorkspaceMounts.reference(workspace), binding.mount)
          ) {
            unresolved = "A Workspace file Use has another original mounted Workspace"
            continue
          }
          next.set(JSON.stringify([binding.scopeID, environment.id, "use", use.id]), {
            grantID: grant.grantID,
            generation: binding.generation,
            scopeID: binding.scopeID,
            useID: use.id,
            reason: "workspace-files",
          })
          continue
        }
        if (inspected.origin.kind !== "host" || inspected.origin.owner !== hostOwner) {
          unresolved = "An Environment Use has unknown service ownership"
          continue
        }
        const binding = Protocol.readHostInvocation(inspected.origin.invocationID)
        const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(binding.grantID))
        if (!grant) {
          unresolved = "An Environment Use has no canonical original grant"
          continue
        }
        const scopeID = OrganizationCloud.scopeID(grant.orgID, grant.projectID)
        const environment = await Environment.get(use.target.environmentID, scopeID)
        if (
          !located.has(environment.id) ||
          environment.id !== use.target.environmentID ||
          environment.state !== "ready" ||
          !Environment.sameTarget(Environment.targetOf(environment), use.target)
        ) {
          unresolved = "An Environment Use has another original native target"
          continue
        }
        await retained(
          binding,
          environment,
          "use",
          use.id,
          true,
          use.ownership.kind === "execution-preparation" ? use : undefined,
        )
      }
      if (full && [...canonicalActive].some((id) => !ownedActive.has(id)))
        unresolved = "An unfinished native execution has no original retained Use"
      cold.clear()
      for (const [id, blocker] of next) cold.set(id, blocker)
      if (full) inventoryFailure = unresolved
      unknown = unresolved ?? inventoryFailure
      if (!unknown && !cold.size && !Environment.hasPendingRequests() && !EnvironmentExecution.hasPendingRequests()) {
        coldTail?.close()
        coldTail = undefined
      }
      if (!unknown && !Environment.hasPendingRequests() && !EnvironmentExecution.hasPendingRequests()) {
        for (const [id, admission] of unresolvedAdmissions) {
          if ([...cold.values()].some((blocker) => blocker.grantID === admission.grantID)) continue
          admission.tail.close()
          unresolvedAdmissions.delete(id)
        }
      }
      owner()
    })
  }
  async function resolve(
    evidence: Grants.EnvironmentAuthority,
    operation: Extract<Protocol.Operation, { action: "resolve" }>,
    markEffect: () => void,
  ) {
    const frame = Grants.environmentAuthority(evidence)
    const selectedEnvironment = frame.grant.selection.infrastructure.environment
    if (!selectedEnvironment) fail("RESOURCE_UNAVAILABLE", "Environment admission has no selected compute resource")
    owner()
    if (!accepting) fail("SERVICE_UNAVAILABLE", "Organization Environment admission is closed")
    await readBlockers()
    if (unknown) fail("RESOURCE_UNAVAILABLE", unknown)
    const input = {
      grant: frame.grant,
      nativeOperationID: operation.nativeOperationID,
      origin: operation.origin,
      capability: operation.capability,
      workspace: operation.workspace,
    }
    const requestDigest = digest(input),
      leaseID = "org_admission_" + requestDigest
    const previous = admissions.get(leaseID)
    if (previous) {
      if (previous.digest !== requestDigest)
        fail("PROTOCOL_MISMATCH", "Environment admission already has another original body")
      return previous.promise
    }
    const tail = OrganizationServiceMaintenance.captureTail()
    const pending = OrganizationCloud.withExecutionSelection(evidence, async (selection) => {
      const expected = operation.workspace
      if (
        expected.generation !== selection.workspace.binding.generation ||
        expected.revision !== selection.workspace.revision
      )
        fail("REVISION_CONFLICT", "The selected Working location changed before Environment admission")
      const invocationID = Protocol.hostInvocation({
        version: 1,
        kind: "admission",
        grantID: frame.grant.grantID,
        retentionGeneration: frame.grant.retention.generation,
        leaseID,
        bindingDigest: requestDigest,
      })
      markEffect()
      const resources = await EnvironmentResources.resolve(
        {
          scopeID: selection.scopeID,
          workspaceID: selection.workspace.id,
          workspaceGeneration: expected.generation,
          environmentID: selection.environment.id,
          origin: host.capture(invocationID),
          needs: { workspace: true, execution: operation.capability },
        },
        (cleanup) => {
          admissionCleanups.set(leaseID, { grantID: frame.grant.grantID, cleanup, tail })
        },
      )
      retiring.set(leaseID, { grantID: frame.grant.grantID, resources, tail })
      admissionCleanups.delete(leaseID)
      try {
        frame.assert()
        if (
          !resources.workspace?.activeMount ||
          !resources.environment ||
          !resources.runtime ||
          !resources.executor?.files ||
          !resources.directory
        )
          fail("RESOURCE_UNAVAILABLE", "The Environment has no actual mounted execution runtime")
        if (
          resources.runtime.preparationVersion !== 1 ||
          !resources.executor.inspectPreparation ||
          !resources.executor.releasePreparation
        )
          fail("RESOURCE_UNAVAILABLE", "The selected Environment cannot retain durable preparation version 1")
        if (
          (resources.workspace.content?.manifest ?? null) !== (selection.workspace.content?.manifest ?? null) ||
          (resources.workspace.content?.revision ?? 0) !== (selection.workspace.content?.revision ?? 0)
        )
          fail("REVISION_CONFLICT", "The Working location changed while its Environment was attaching")
        const mount = WorkspaceMounts.reference(resources.workspace)
        const inspected = await resources.executor.files.inspect(mount)
        if (
          !inspected ||
          !same(WorkspaceProtocol.Reference.parse(inspected), mount) ||
          inspected.path !== resources.workspace.activeMount.path
        )
          fail("PROTOCOL_MISMATCH", "Environment has another actual mounted Workspace")
        const relative = await resources.executor.files.canonical(mount, expected.rootPath ?? "", true)
        const item = await resources.executor.files.stat(mount, relative, true)
        if (!item || item.kind !== "directory")
          fail("RESOURCE_UNAVAILABLE", "The selected Working location is not an actual directory")
        const files = resources.runtime.platform === "win32" ? path.win32 : path.posix
        const directory = files.join(resources.workspace.activeMount.path, ...relative.split("/"))
        const reference = Protocol.Reference.parse({
          version: 2,
          nativeOperationID: operation.nativeOperationID,
          preparationVersion: 1,
          orgID: frame.grant.orgID,
          deploymentIncarnation: frame.grant.deploymentIncarnation,
          projectID: frame.grant.projectID,
          runtimeID: frame.grant.runtimeID,
          sessionID: frame.grant.sessionID,
          rootID: frame.rootID,
          bindingEpoch: frame.grant.bindingEpoch,
          grantID: frame.grant.grantID,
          retentionGeneration: frame.grant.retention.generation,
          selectionRevision: frame.grant.selectionRevision,
          resourceID: selectedEnvironment.resourceID,
          environmentID: resources.environment.id,
          serviceScopeID: selection.scopeID,
          hostOwner,
          leaseID,
          target: resources.runtime.target,
          mount: inspected,
          directory,
          workspace: {
            ...expected,
            revision: resources.workspace.revision,
            generation: resources.workspace.binding.generation,
          },
        })
        const lease: Lease = {
          reference,
          requestDigest,
          origin: operation.origin,
          resources,
          tail,
          admissionClosed: false,
          admissionClosing: false,
          admissionAbort: new AbortController(),
          calls: new Set(),
          tailClosed: false,
          operations: new Map(),
          inputs: new Map(),
          sandboxes: new Set(),
          releasedSandboxes: new Set(),
          sandboxPreparations: new Map(),
          preparationReleased: false,
        }
        leases.set(leaseID, lease)
        retiring.delete(leaseID)
        return lease
      } catch (error) {
        await withoutAuthority(() => tail.run(() => resources.release()))
        retiring.delete(leaseID)
        throw error
      }
    })
    admissions.set(leaseID, { digest: requestDigest, promise: pending })
    try {
      return await pending
    } catch (error) {
      const lease = leases.get(leaseID)
      if (lease) await releaseAdmission(lease)
      else if (!retiring.has(leaseID) && !admissionCleanups.has(leaseID)) {
        await withoutAuthority(readBlockers)
        if (!unknown && ![...cold.values()].some((blocker) => blocker.grantID === frame.grant.grantID)) tail.close()
        else unresolvedAdmissions.set(leaseID, { grantID: frame.grant.grantID, tail })
      }
      throw error
    }
  }
  function runtimeOf(lease: Lease) {
    const runtime = lease.resources.runtime
    const executor = lease.resources.executor
    if (!runtime || !executor) fail("RESOURCE_UNAVAILABLE", "The original Environment executor is unavailable")
    return { runtime, executor }
  }
  async function operationOf(lease: Lease, id: string) {
    const operation = lease.operations.get(id)
    if (!operation) fail("PERMISSION_DENIED", "The original live lease did not accept this operation")
    const info = await EnvironmentExecution.get(operation.physicalID, lease.reference.serviceScopeID)
    await actual(info, lease.reference, operation.invocationID, operation.digest)
    return { operation, info }
  }
  async function dispatch(evidence: Grants.EnvironmentAuthority, markEffect: () => void) {
    const frame = Grants.environmentAuthority(evidence)
    if (frame.kind !== "dispatch") fail("PERMISSION_DENIED", "Retained inspection cannot dispatch")
    const operation = Protocol.Request.parse(frame.request).proof.operation
    if (Buffer.byteLength(JSON.stringify(operation)) > frame.grant.limits.requestBytes)
      fail("INVALID_REQUEST", "Environment request exceeds its accepted root capacity")
    if (operation.action === "resolve") {
      const lease = await resolve(evidence, operation, markEffect)
      return Protocol.Result.parse({
        reference: lease.reference,
        action: operation.action,
        value: null,
        runtime: lease.resources.runtime,
      })
    }
    const lease = selected(operation.reference)
    if (
      "id" in operation &&
      operation.action !== "release-sandbox" &&
      operation.id !== lease.reference.nativeOperationID
    )
      fail("PROTOCOL_MISMATCH", "Environment operation changed its original native identity")
    const { executor } = runtimeOf(lease)
    await frame.recheck()
    if (operation.action === "release-admission") {
      markEffect()
      await releaseAdmission(lease)
      await readBlockers()
      return Protocol.Result.parse({ reference: lease.reference, action: operation.action, value: null })
    }
    if (
      ["start", "prepare-inputs", "prepare-sandbox"].includes(operation.action) &&
      (lease.admissionClosing || lease.admissionClosed || !accepting)
    )
      fail("PERMISSION_DENIED", "The original Environment admission no longer accepts new work")
    let value: unknown
    switch (operation.action) {
      case "prepare-inputs": {
        const input = ExecutionProtocol.Inputs.parse(operation.input)
        if (input.id !== operation.id)
          fail("PROTOCOL_MISMATCH", "Preparation inputs changed their original native operation")
        const requestDigest = digest(input)
        const previous = lease.inputs.get(input.id)
        if (previous) {
          if (previous.digest !== requestDigest || previous.released)
            fail("PROTOCOL_MISMATCH", "Original prepared inputs cannot change or reopen")
          markEffect()
          value = await previous.promise
          break
        }
        if (lease.admissionClosing) fail("PERMISSION_DENIED", "Original Environment admission is retiring")
        markEffect()
        const pending = tracked(lease, async () => {
          const preparation = await prepare(lease, markEffect)
          return preparation.prepareInputs({ ...input, id: preparation.id })
        })
        lease.inputs.set(input.id, {
          digest: requestDigest,
          promise: pending,
          released: false,
        })
        value = await pending
        break
      }
      case "discard-inputs": {
        const input = lease.inputs.get(operation.id)
        if (!input || !lease.prepared) fail("PERMISSION_DENIED", "The original admission did not prepare these inputs")
        if (!input.released) {
          markEffect()
          await Promise.allSettled([input.promise])
          const preparation = lease.prepared
          await withPreparationCompletion(preparation, lease.reference, lease.origin, lease.tail, () =>
            preparation.discardInputs(),
          )
          input.released = true
        }
        closeTail(lease)
        value = null
        break
      }
      case "prepare-sandbox": {
        const input = ExecutionProtocol.SandboxInput.parse(operation.input)
        if (
          (input.operationID !== undefined && input.operationID !== operation.id) ||
          input.workspace !== lease.reference.directory ||
          (input.executionCwd && input.executionCwd !== lease.reference.directory)
        )
          fail("PERMISSION_DENIED", "Sandbox preparation has another Working location")
        const identity = digest(input)
        const previous = lease.sandboxPreparations.get(identity)
        if (previous) {
          if (previous.released) fail("PERMISSION_DENIED", "Original sandbox preparation has ended")
          markEffect()
          value = await previous.promise
          break
        }
        markEffect()
        const pending = tracked(lease, async () => {
          const preparation = await prepare(lease, markEffect)
          return preparation.prepareSandbox({ ...input, operationID: preparation.id })
        })
        const preparation: SandboxPreparation = { promise: pending, released: false }
        lease.sandboxPreparations.set(identity, preparation)
        const sandbox = await pending
        preparation.id = sandbox.id
        lease.sandboxes.add(sandbox.id)
        value = sandbox
        break
      }
      case "release-sandbox": {
        if (!lease.releasedSandboxes.has(operation.id)) {
          if (!lease.sandboxes.has(operation.id) || !lease.prepared)
            fail("PERMISSION_DENIED", "The original admission did not prepare this sandbox")
          markEffect()
          const preparation = lease.prepared
          await withPreparationCompletion(preparation, lease.reference, lease.origin, lease.tail, () =>
            preparation.releaseSandbox(operation.id),
          )
          lease.sandboxes.delete(operation.id)
          lease.releasedSandboxes.add(operation.id)
          for (const preparation of lease.sandboxPreparations.values())
            if (preparation.id === operation.id) preparation.released = true
        }
        closeTail(lease)
        value = null
        break
      }
      case "start": {
        if (!same(operation.origin, lease.origin))
          fail("PERMISSION_DENIED", "New Environment execution requires its original native admission origin")
        const request = ExecutionProtocol.Request.parse(operation.request)
        const mount = WorkspaceProtocol.Mount.parse(lease.reference.mount)
        const command = request.command
        if (
          request.id !== operation.id ||
          !Environment.sameTarget(request.target, Environment.Target.parse(lease.reference.target)) ||
          request.digest !== ExecutionProtocol.digest(command) ||
          !same(command.capture, [WorkspaceProtocol.Reference.parse(mount)]) ||
          !command.useRoots.includes(mount.path) ||
          (command.sandboxID && !lease.sandboxes.has(command.sandboxID))
        )
          fail("PROTOCOL_MISMATCH", "Environment start changed its canonical command or mounted capture")
        const paths = runtimeOf(lease).runtime.platform === "win32" ? path.win32 : path.posix
        const relative = paths.relative(mount.path, command.cwd)
        if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + paths.sep))
          fail("PERMISSION_DENIED", "Environment command escaped its actual mounted Working location")
        const canonical = await executor.files!.canonical(mount, relative.split(paths.sep).join("/"), true)
        const directory = paths.join(mount.path, ...canonical.split("/"))
        const contained = paths.relative(lease.reference.directory, directory)
        if (paths.isAbsolute(contained) || contained === ".." || contained.startsWith(".." + paths.sep))
          fail("PERMISSION_DENIED", "Environment command escaped its selected Working subtree")
        const item = await executor.files!.stat(mount, canonical, true)
        if (!item || item.kind !== "directory")
          fail("RESOURCE_UNAVAILABLE", "Environment command has no actual directory")
        if (lease.admissionClosing) fail("PERMISSION_DENIED", "Original Environment admission is retiring")
        const identity = await Protocol.operationIdentity(lease.reference, operation.id, operation.origin)
        const previous = lease.operations.get(operation.id)
        if (
          previous &&
          (previous.physicalID !== identity.operationID ||
            previous.digest !== request.digest ||
            !same(previous.origin, operation.origin))
        )
          fail("PROTOCOL_MISMATCH", "The original Environment operation cannot change its body")
        const accepted = previous ?? {
          nativeID: operation.id,
          origin: operation.origin,
          physicalID: identity.operationID,
          invocationID: identity.invocationID,
          digest: request.digest,
          completed: false,
          sandboxID: command.sandboxID,
        }
        lease.operations.set(operation.id, accepted)
        try {
          markEffect()
          await prepare(lease, markEffect)
          const info = await tracked(lease, () =>
            EnvironmentExecution.start({
              id: accepted.physicalID,
              scopeID: lease.reference.serviceScopeID,
              environmentID: lease.reference.environmentID,
              command,
              origin: host.capture(accepted.invocationID),
              intentDigest: operation.intentDigest,
              workspaces: [WorkspaceProtocol.Reference.parse(mount)],
              signal: lease.admissionAbort.signal,
            }),
          )
          value = await actual(info, lease.reference, accepted.invocationID, accepted.digest)
          void finish(lease, accepted).catch(() => {})
        } catch (error) {
          const info = await EnvironmentExecution.get(accepted.physicalID, lease.reference.serviceScopeID).catch(
            (readError: unknown) => {
              if (readError instanceof Storage.NotFoundError) return
              throw readError
            },
          )
          if (info) {
            await actual(info, lease.reference, accepted.invocationID, accepted.digest)
            void finish(lease, accepted).catch(() => {})
          } else lease.operations.delete(operation.id)
          throw error
        }
        break
      }
      case "status": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        value = await actual(
          await EnvironmentExecution.reconcile(accepted.physicalID, lease.reference.serviceScopeID),
          lease.reference,
          accepted.invocationID,
          accepted.digest,
        )
        break
      }
      case "output": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        value = await EnvironmentExecution.output(
          accepted.physicalID,
          lease.reference.serviceScopeID,
          operation.after,
          operation.limit,
        )
        break
      }
      case "stdin": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        const bytes = Buffer.from(operation.data, "base64")
        if (bytes.toString("base64") !== operation.data)
          fail("INVALID_REQUEST", "Environment stdin must be canonical base64")
        markEffect()
        await EnvironmentExecution.stdin(accepted.physicalID, lease.reference.serviceScopeID, bytes, operation.end)
        value = null
        break
      }
      case "resize": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        markEffect()
        await EnvironmentExecution.resize(
          accepted.physicalID,
          lease.reference.serviceScopeID,
          operation.cols,
          operation.rows,
        )
        value = null
        break
      }
      case "cancel": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        if (operation.digest !== accepted.digest)
          fail("PROTOCOL_MISMATCH", "Environment cancellation has another command digest")
        markEffect()
        await EnvironmentExecution.cancel(accepted.physicalID, lease.reference.serviceScopeID)
        value = null
        break
      }
      case "complete": {
        const { operation: accepted } = await operationOf(lease, operation.id)
        if (operation.digest !== accepted.digest)
          fail("PROTOCOL_MISMATCH", "Environment completion has another command digest")
        markEffect()
        value = await finish(lease, accepted)
        await readBlockers()
        break
      }
    }
    owner()
    return Protocol.Result.parse({ reference: lease.reference, action: operation.action, value: z.json().parse(value) })
  }
  function retirementQuery(value: Protocol.RetirementRequest | Protocol.RetirementInspectionRequest) {
    const proof = value.proof
    return Protocol.RetirementQuery.parse({
      kind: proof.kind,
      reference: proof.reference,
      origin: proof.origin,
      ...(proof.kind === "execution" && { id: proof.id, digest: proof.digest }),
    })
  }
  function retirementLease(query: Protocol.RetirementQuery) {
    const lease = leases.get(query.reference.leaseID)
    if (lease && (!same(lease.reference, query.reference) || !same(lease.origin, query.origin)))
      fail("PROTOCOL_MISMATCH", "Environment retirement has another original live owner")
    return lease
  }
  async function retirementReceipt(query: Protocol.RetirementQuery): Promise<Protocol.RetirementResult> {
    owner()
    const reference = query.reference
    if (query.kind === "execution") {
      const info = await inspectOriginal(reference, query.id, query.origin, query.digest)
      return Protocol.RetirementResult.parse({
        kind: "execution",
        reference,
        id: query.id,
        digest: query.digest,
        execution: info?.state === "completed" ? z.json().parse(info) : null,
      })
    }
    const lease = retirementLease(query)
    if (!lease) return { kind: "admission", reference, released: false }
    const uses = await Environment.uses(reference.environmentID)
    const admission = lease.resources.origin?.value
    if (!admission) fail("RESOURCE_UNAVAILABLE", "Original Environment admission has no native ownership proof")
    const retained = uses.some((use) => {
      if (!same(use.target, reference.target)) return false
      if (use.ownership.kind === "legacy-unknown") return true
      return use.kind === "admission" && use.ownership.kind === "admission" && same(use.ownership.origin, admission)
    })
    return { kind: "admission", reference, released: lease.admissionClosed && !retained }
  }
  async function retireOriginal(query: Protocol.RetirementQuery, markEffect: () => void) {
    owner()
    const reference = query.reference,
      lease = retirementLease(query)
    if (query.kind === "admission") {
      if (!lease) fail("RESOURCE_UNAVAILABLE", "Original Environment admission has no retained cleanup facet")
      markEffect()
      await withoutAuthority(() => releaseAdmission(lease))
      closeTail(lease)
    } else {
      const info = await inspectOriginal(reference, query.id, query.origin, query.digest)
      if (!info) fail("RESOURCE_UNAVAILABLE", "Original Environment operation has no native receipt")
      if (info.state !== "completed") {
        const operation = lease?.operations.get(query.id)
        markEffect()
        if (lease && operation) await withoutAuthority(() => finish(lease, operation, true))
        else {
          if (!coldTail) fail("RESOURCE_UNAVAILABLE", "Original Environment operation has no native completion owner")
          await withCompletion(info, coldTail, async () => {
            await EnvironmentExecution.cancel(info.id, info.scopeID)
            const executor = await EnvironmentExecution.connect(info)
            for (;;) {
              const observed = await EnvironmentExecution.reconcile(info.id, info.scopeID)
              const identity = await Protocol.operationIdentity(reference, query.id, query.origin)
              await actual(observed, reference, identity.invocationID, query.digest)
              if (observed.state === "completed") break
              if (["exited", "unsaved", "saved"].includes(observed.state)) {
                await EnvironmentExecution.complete(observed.id, observed.scopeID)
                break
              }
              if (observed.state === "unknown")
                fail("RESOURCE_UNAVAILABLE", "Original Environment retirement remains unknown")
              if (observed.status && executor.waitForChange) await executor.waitForChange(info.id, observed.status, 250)
              else await new Promise<void>((resolve) => setTimeout(resolve, 25))
            }
          })
        }
      } else if (lease) {
        const operation = lease.operations.get(query.id)
        if (operation) await withoutAuthority(() => finish(lease, operation))
      }
    }
    await readBlockers()
    return retirementReceipt(query)
  }
  return {
    async retire(value: Protocol.RetirementRequest, signal?: AbortSignal) {
      owner()
      let dispatched = false
      try {
        return await options.grants.withEnvironmentRetirement(value, signal, async (evidence) => {
          const frame = Grants.environmentAuthority(evidence)
          if (frame.kind !== "retirement")
            fail("PERMISSION_DENIED", "Environment retirement requires its original receipt owner")
          const request = Protocol.RetirementRequest.parse(frame.request),
            query = retirementQuery(request)
          if (query.reference.serviceScopeID !== OrganizationCloud.scopeID(frame.grant.orgID, frame.grant.projectID))
            fail("PROTOCOL_MISMATCH", "Environment retirement has another original native Scope")
          return marked(frame.grant.grantID, async () => {
            await frame.recheck()
            return retireOriginal(query, () => {
              frame.assert()
              dispatched = true
            })
          })
        })
      } catch (error) {
        if (!dispatched) throw error
        throw new OrganizationError({
          ...(error instanceof OrganizationError ? error.data : {}),
          code: error instanceof OrganizationError ? error.data.code : "SERVICE_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Original Environment retirement is unconfirmed",
          outcome: "unknown",
          retryable: false,
        })
      }
    },
    async inspectRetirement(value: Protocol.RetirementInspectionRequest, signal?: AbortSignal) {
      owner()
      return options.grants.withEnvironmentRetirementInspection(value, signal, async (evidence) => {
        const frame = Grants.environmentAuthority(evidence)
        if (frame.kind !== "retirement")
          fail("PERMISSION_DENIED", "Environment retirement inspection requires its original receipt owner")
        const query = retirementQuery(Protocol.RetirementInspectionRequest.parse(frame.request))
        const result = await retirementReceipt(query)
        await frame.recheck()
        return result
      })
    },
    async withWorkspaceFiles<T>(
      evidence: Grants.WorkspaceAuthority,
      value: WorkspaceCatalog.Info,
      signal: AbortSignal | undefined,
      body: (files: OrganizationCloud.LiveFiles) => Promise<T>,
    ): Promise<T> {
      owner()
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Live Workspace files must precede native acquisition")
      if (!accepting) fail("SERVICE_UNAVAILABLE", "Organization Workspace file admission is closed")
      const frame = Grants.workspaceAuthority(evidence)
      const grant = frame.grant
      if (grant.state !== "bound") fail("PERMISSION_DENIED", "Live Workspace files require their original bound root")
      const selected = grant.selection.infrastructure.workspace
      const workspace = WorkspaceCatalog.Info.parse(structuredClone(value))
      const mount = workspace.activeMount
      const scopeID = OrganizationCloud.scopeID(grant.orgID, grant.projectID)
      if (
        !selected ||
        selected.workspaceID !== workspace.id ||
        workspace.scopeID !== scopeID ||
        mount?.state !== "active" ||
        workspace.binding.state !== "bound"
      )
        fail("PERMISSION_DENIED", "Live files have another accepted Workspace or mounted owner")
      const requestID = crypto.randomUUID()
      const binding = FilesBinding.parse({
        version: 1,
        kind: "workspace-files",
        grantID: grant.grantID,
        generation: grant.retention.generation,
        scopeID,
        workspaceID: workspace.id,
        workspaceGeneration: workspace.binding.generation,
        target: mount.target,
        mount: WorkspaceMounts.reference(workspace),
        path: mount.path,
        requestID,
      })
      const invocationID = JSON.stringify(binding)
      filesBinding(invocationID)
      let open = true
      const assert = () => {
        owner()
        signal?.throwIfAborted()
        frame.assert()
        if (!open) fail("PERMISSION_DENIED", "Live Workspace file callback has ended")
      }
      const recheck = async () => {
        assert()
        await frame.recheck()
        await OrganizationCloud.assertInfrastructure(grant.orgID, grant.projectID, {
          workspace: selected,
          environment: null,
        })
        const current = await WorkspaceCatalog.assertActive(workspace.id, scopeID)
        if (
          current.binding.state !== "bound" ||
          current.binding.generation !== workspace.binding.generation ||
          !same(current.activeMount, mount)
        )
          fail("REVISION_CONFLICT", "Live Workspace changed its original mounted binding")
        await Environment.assertTarget(mount.target, scopeID)
        assert()
      }
      await recheck()
      const tail = OrganizationServiceMaintenance.captureTail()
      const pending = new Set<Promise<unknown>>()
      let cleanup: EnvironmentResources.Cleanup | undefined
      let resolved: EnvironmentResources.Resolved | undefined
      const nativeFrame = { invocationID, scopeID, target: mount.target, assert, recheck }
      const failures: unknown[] = []
      let result: { value: T } | undefined
      unresolvedAdmissions.set(requestID, { grantID: grant.grantID, tail })
      return marked(grant.grantID, () =>
        filesAuthority.run(nativeFrame, async () => {
          try {
            resolved = await EnvironmentResources.resolve(
              {
                scopeID,
                environmentID: mount.target.environmentID,
                workspaceID: workspace.id,
                workspaceGeneration: workspace.binding.generation,
                origin: filesHost.capture(invocationID),
                needs: { workspace: true },
                signal,
              },
              (original) => {
                cleanup = original
                admissionCleanups.set(requestID, { grantID: grant.grantID, cleanup: original, tail })
                unresolvedAdmissions.delete(requestID)
              },
            )
            const files = resolved.executor?.files
            if (!files || !resolved.workspace || !same(resolved.workspace.activeMount, mount))
              fail("RESOURCE_UNAVAILABLE", "Live Workspace has no exact original FileHost")
            const actual = await files.inspect(binding.mount)
            if (
              !actual ||
              !same(WorkspaceProtocol.Reference.parse(actual), binding.mount) ||
              actual.path !== mount.path
            )
              fail("PROTOCOL_MISMATCH", "Live Workspace has another actual native mount")
            const current = async () => {
              await recheck()
              if (!same(await files.inspect(binding.mount), actual))
                fail("REVISION_CONFLICT", "The original native file mount changed")
              assert()
            }
            const call = async <R>(body: () => Promise<R>): Promise<R> => {
              assert()
              const promise = (async () => {
                await current()
                const result = await body()
                await current()
                return result
              })()
              pending.add(promise)
              try {
                return await promise
              } finally {
                pending.delete(promise)
              }
            }
            result = {
              value: await body(
                Object.freeze({
                  mount: WorkspaceProtocol.Mount.parse(actual),
                  assert,
                  recheck: current,
                  files: Object.freeze({
                    canonical: (path: string, follow: boolean) =>
                      call(() => files.canonical(binding.mount, path, follow)),
                    stat: (path: string, follow?: boolean) => call(() => files.stat(binding.mount, path, follow)),
                    read: (input: Omit<WorkspaceProtocol.ReadInput, "mount">) =>
                      call(() =>
                        files.read({
                          ...WorkspaceProtocol.ReadInput.omit({ mount: true }).parse(input),
                          mount: binding.mount,
                        }),
                      ),
                  }),
                }),
              ),
            }
            await current()
          } catch (error) {
            failures.push(error)
          } finally {
            open = false
            await Promise.allSettled(pending)
            try {
              if (cleanup) {
                const original = cleanup
                await filesAuthority.run(undefined, () => withoutAuthority(() => tail.run(() => original.release())))
                admissionCleanups.delete(requestID)
                unresolvedAdmissions.delete(requestID)
                tail.close()
              } else {
                const use = (await Environment.uses(mount.target.environmentID)).some(
                  (use) =>
                    use.ownership.kind === "admission" &&
                    use.ownership.origin.kind === "host" &&
                    use.ownership.origin.owner === filesHostOwner &&
                    use.ownership.origin.invocationID === invocationID,
                )
                if (!use) {
                  unresolvedAdmissions.delete(requestID)
                  tail.close()
                }
              }
            } catch (error) {
              failures.push(error)
            }
          }
          if (failures.length === 1) throw failures[0]
          if (failures.length)
            throw new AggregateError(failures, "Live Workspace files and original Use cleanup failed")
          if (!result) fail("SERVICE_UNAVAILABLE", "Live Workspace file callback did not settle")
          return result.value
        }),
      )
    },
    async ready() {
      owner()
      try {
        await readBlockers(true)
      } catch (error) {
        inventoryFailure = error instanceof Error ? error.message : "Native Environment facts are unavailable"
        unknown = inventoryFailure
      }
      if (unknown || cold.size) coldTail = OrganizationServiceMaintenance.captureTail()
      accepting = true
    },
    async prepareDrained(grantID: string) {
      owner()
      await readBlockers()
      this.assertDrained(grantID)
    },
    assertDrained(grantID: string) {
      owner()
      if (unknown) fail("RESOURCE_UNAVAILABLE", unknown)
      if (Environment.hasPendingRequests() || EnvironmentExecution.hasPendingRequests())
        fail("RESOURCE_UNAVAILABLE", "Native Environment admission or saving is still pending")
      if (
        active.get(grantID) ||
        [...unresolvedAdmissions.values()].some((admission) => admission.grantID === grantID) ||
        [...admissionCleanups.values()].some((admission) => admission.grantID === grantID) ||
        [...retiring.values()].some((admission) => admission.grantID === grantID) ||
        [...cold.values()].some((blocker) => blocker.grantID === grantID) ||
        [...leases.values()].some(
          (lease) =>
            lease.reference.grantID === grantID &&
            (!lease.admissionClosed ||
              hasPreparations(lease) ||
              lease.sandboxes.size ||
              [...lease.operations.values()].some((operation) => !operation.completed)),
        )
      )
        fail("RESOURCE_UNAVAILABLE", "Original Environment Uses, execution, output or checkpoints are still draining")
    },
    async request(value: Protocol.Request, signal?: AbortSignal) {
      owner()
      let dispatched = false
      try {
        return await options.grants.withEnvironment(value, signal, (evidence) => {
          const frame = Grants.environmentAuthority(evidence)
          return marked(frame.grant.grantID, () =>
            authority.run(frame, async () => {
              await frame.recheck()
              return dispatch(evidence, () => {
                dispatched = true
              })
            }),
          )
        })
      } catch (error) {
        if (!dispatched) throw error
        throw new OrganizationError({
          ...(error instanceof OrganizationError ? error.data : {}),
          code: error instanceof OrganizationError ? error.data.code : "SERVICE_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Original Environment operation outcome is unknown",
          outcome: "unknown",
          retryable: false,
        })
      }
    },
    async inspect(value: Protocol.InspectionRequest, signal?: AbortSignal) {
      owner()
      return options.grants.withEnvironmentInspection(value, signal, async (evidence) => {
        const frame = Grants.environmentAuthority(evidence)
        if (frame.kind !== "inspection")
          fail("PERMISSION_DENIED", "Environment inspection requires its original receipt owner")
        const proof = Protocol.InspectionRequest.parse(frame.request).proof
        if (proof.reference.serviceScopeID !== OrganizationCloud.scopeID(frame.grant.orgID, frame.grant.projectID))
          fail("PERMISSION_DENIED", "Environment inspection has another original service Scope")
        if (proof.kind === "preparation") {
          if (proof.id !== proof.reference.nativeOperationID)
            fail("PROTOCOL_MISMATCH", "Preparation inspection changed its original native identity")
          const lease = leases.get(proof.reference.leaseID)
          if (lease && (!same(lease.reference, proof.reference) || !same(lease.origin, proof.origin)))
            fail("PROTOCOL_MISMATCH", "Preparation inspection has another original admission")
          const preparation = lease?.prepared ?? (await retainedPreparation(proof.reference, proof.origin))
          const observed = preparation ? await preparation.inspect() : undefined
          await frame.recheck()
          return Protocol.InspectionResult.parse({
            kind: "preparation",
            reference: proof.reference,
            id: proof.id,
            preparation: observed ? z.json().parse(observed) : null,
          })
        }
        let info = await inspectOriginal(proof.reference, proof.id, proof.origin, proof.digest)
        if (info && info.state !== "completed") {
          const original = info
          const lease = leases.get(proof.reference.leaseID)
          const tail = lease?.tail ?? coldTail
          if (!tail) fail("RESOURCE_UNAVAILABLE", "The original Environment completion has no retained native owner")
          info = await withCompletion(original, tail, async () => {
            const current = await EnvironmentExecution.reconcile(original.id, original.scopeID)
            const identity = await Protocol.operationIdentity(proof.reference, proof.id, proof.origin)
            await actual(current, proof.reference, identity.invocationID, proof.digest)
            if (!["exited", "unsaved", "saved"].includes(current.state)) return current
            const completed = await EnvironmentExecution.complete(current.id, current.scopeID)
            return actual(completed, proof.reference, identity.invocationID, proof.digest)
          })
          await readBlockers()
        }
        const output = info ? await EnvironmentExecution.output(info.id, info.scopeID, proof.after, proof.limit) : []
        await frame.recheck()
        return Protocol.InspectionResult.parse({
          kind: "execution",
          reference: proof.reference,
          id: proof.id,
          digest: proof.digest,
          execution: info ? z.json().parse(info) : null,
          output: z.array(z.json()).parse(output),
        })
      })
    },
    close() {
      owner()
      accepting = false
      if (closing) return closing
      const pending = withoutAuthority(async () => {
        for await (const { environment } of OrganizationCloud.environmentEntries())
          if (environment.state === "releasing") await Environment.reconcile(environment.id, environment.scopeID)
        for (const lease of leases.values()) {
          for (const operation of lease.operations.values()) await finish(lease, operation, true)
          await releaseAdmission(lease)
          closeTail(lease)
        }
        for (const [id, admission] of retiring) {
          await admission.tail.run(() => admission.resources.release())
          retiring.delete(id)
          admission.tail.close()
        }
        for (const [id, admission] of admissionCleanups) {
          await admission.tail.run(() => admission.cleanup.release())
          admissionCleanups.delete(id)
          admission.tail.close()
        }
        await readBlockers(true)
        for (const blocker of cold.values()) {
          if (blocker.preparation) {
            const use = blocker.preparation
            if (use.ownership.kind !== "execution-preparation" || use.ownership.origin.kind !== "host" || !coldTail)
              fail("RESOURCE_UNAVAILABLE", "Cold preparation has no original finite completion owner")
            const binding = Protocol.readHostInvocation(use.ownership.origin.invocationID)
            if (binding.kind !== "execution")
              fail("PROTOCOL_MISMATCH", "Cold preparation has another original operation binding")
            const preparation = await EnvironmentExecution.retainedPreparation(use)
            await withPreparationCompletion(preparation, binding.reference, binding.nativeOrigin, coldTail, () =>
              preparation.release(),
            )
            continue
          }
          if (!blocker.operationID) continue
          const info = await EnvironmentExecution.get(blocker.operationID, blocker.scopeID)
          if (info.state !== "completed") {
            if (!coldTail || info.origin.kind !== "host" || info.origin.owner !== hostOwner)
              fail("RESOURCE_UNAVAILABLE", "Cold Environment completion has no original native tail")
            const binding = Protocol.readHostInvocation(info.origin.invocationID)
            if (
              binding.kind !== "execution" ||
              binding.operationID !== info.id ||
              binding.grantID !== blocker.grantID ||
              binding.retentionGeneration !== blocker.generation
            )
              fail("PERMISSION_DENIED", "Cold Environment completion changed its original accepted identity")
            await withCompletion(info, coldTail, async () => {
              await EnvironmentExecution.cancel(info.id, info.scopeID)
              const current = await EnvironmentExecution.reconcile(info.id, info.scopeID)
              if (!["exited", "unsaved", "saved", "completed"].includes(current.state))
                fail("RESOURCE_UNAVAILABLE", "Original cold Environment execution has not physically drained")
              if (current.state !== "completed") await EnvironmentExecution.complete(current.id, current.scopeID)
            })
          }
        }
        await readBlockers(true)
        if (
          unknown ||
          cold.size ||
          unresolvedAdmissions.size ||
          admissionCleanups.size ||
          retiring.size ||
          active.size ||
          [...leases.values()].some(
            (lease) =>
              !lease.admissionClosed ||
              hasPreparations(lease) ||
              [...lease.operations.values()].some((operation) => !operation.completed),
          )
        )
          fail("RESOURCE_UNAVAILABLE", unknown ?? "Original Environment facts have not drained")
        for await (const { environment } of OrganizationCloud.environmentEntries()) {
          if (environment.state === "idle") continue
          if (environment.state !== "ready")
            fail("RESOURCE_UNAVAILABLE", "The original Environment allocation is unresolved")
          for await (const mount of WorkspaceMounts.releaseMounts(environment))
            await WorkspaceMounts.detach({ workspaceID: mount.workspaceID, scopeID: environment.scopeID })
          await Environment.deallocate(environment.id, {
            scopeID: environment.scopeID,
            expectedGeneration: environment.generation,
          })
        }
      })
      closing = pending
      void pending.catch(() => {
        if (closing === pending) closing = undefined
      })
      return pending
    },
  }
}
export type OrganizationCloudEnvironments = ReturnType<typeof createOrganizationCloudEnvironments>
