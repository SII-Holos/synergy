import { z } from "zod"
import path from "node:path"
import {
  OrganizationCloudExecutionProtocol as Protocol,
  OrganizationCloudProtocol as Cloud,
} from "@ericsanchezok/synergy-organization-protocol"
import { EnvironmentExecutionSource as Source } from "@ericsanchezok/synergy-harness/environment/execution-source"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { OrganizationExecutionLeases as Leases } from "./execution-leases"
import {
  withMemberEnvironment,
  inspectMemberEnvironment,
  retireMemberEnvironment,
  inspectMemberEnvironmentRetirement,
} from "./execution-source"
import { ProcessAccessSource } from "@ericsanchezok/synergy-harness/process/access-source"
import { RuntimeIdentity } from "./home"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationEnvironmentExecutionSource {
  const Binding = z.strictObject({
    version: z.literal(2),
    reference: Protocol.Reference,
    authority: Leases.Authority,
    scopeID: z.string().min(1),
    origin: EnvironmentOrigin.Session,
    grantID: z.string().min(1),
    generation: z.number().int().positive().safe(),
  })
  type Binding = z.infer<typeof Binding>
  function denied(message: string): never {
    throw new OrganizationRuntimeError({
      code: "RESOURCE_UNAVAILABLE",
      message,
      outcome: "not_dispatched",
      retryable: false,
    })
  }
  function unknown(message: string): never {
    throw new OrganizationRuntimeError({ code: "SERVICE_UNAVAILABLE", message, outcome: "unknown", retryable: false })
  }
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  async function mirror(binding: Binding, id: string, digest: string, value: unknown) {
    const raw = JsonValue.parse(value)
    const observation = EnvironmentExecution.Info.parse(raw)
    const identity = await Protocol.operationIdentity(binding.reference, id, binding.origin)
    const mount = WorkspaceProtocol.Mount.parse(binding.reference.mount)
    if (
      observation.source !== undefined ||
      observation.sourceObservation !== undefined ||
      observation.id !== identity.operationID ||
      observation.scopeID !== binding.reference.serviceScopeID ||
      observation.digest !== digest ||
      !Environment.sameTarget(observation.target, Environment.Target.parse(binding.reference.target)) ||
      !same(observation.origin, {
        kind: "host",
        owner: binding.reference.hostOwner,
        invocationID: identity.invocationID,
      }) ||
      !same(observation.workspaces, [WorkspaceProtocol.Reference.parse(mount)]) ||
      (observation.status &&
        (observation.status.id !== observation.id ||
          observation.status.digest !== digest ||
          !Environment.sameTarget(observation.status.target, observation.target)))
    )
      unknown("Environment returned another actual physical operation or native owner")
    return EnvironmentExecution.Info.parse({
      ...observation,
      id,
      scopeID: binding.scopeID,
      origin: binding.origin,
      status: observation.status && { ...observation.status, id },
      sourceObservation: raw,
    })
  }
  function retained(
    value: unknown,
    identity: RuntimeIdentity,
    runtimeID: string,
    scopeID: string,
    origin: EnvironmentOrigin.Info,
  ) {
    const binding = Binding.parse(value),
      ref = binding.reference,
      authority = binding.authority
    if (
      ref.orgID !== identity.orgID ||
      ref.runtimeID !== runtimeID ||
      ref.projectID !== scopeID ||
      binding.scopeID !== scopeID ||
      !same(binding.origin, origin) ||
      binding.origin.scopeID !== scopeID ||
      authority.orgID !== ref.orgID ||
      authority.deploymentIncarnation !== ref.deploymentIncarnation ||
      authority.runtimeID !== ref.runtimeID ||
      authority.sessionID !== ref.sessionID ||
      authority.projectID !== ref.projectID ||
      authority.rootID !== ref.rootID ||
      authority.bindingEpoch !== ref.bindingEpoch ||
      EnvironmentExecution.operationID(binding.origin) !== ref.nativeOperationID ||
      binding.grantID !== ref.grantID ||
      binding.generation !== ref.retentionGeneration
    )
      denied("Environment receipt has another original Home, Scope or accepted root")
    return binding
  }

  export function register(value: RuntimeIdentity, selectedRuntimeID: string) {
    const identity = RuntimeIdentity.parse(value)
    const runtimeID = Protocol.Reference.shape.runtimeID.parse(selectedRuntimeID)
    const live = new Set<{ close(): Promise<void> }>()
    const unresolved = new Set<{ close(): Promise<void> }>()
    Source.register("organization", {
      async selected(selection, signal) {
        return withMemberEnvironment(
          { sessionID: selection.ownerID, scopeID: selection.scopeID, signal },
          async (resolution) => {
            if (
              resolution.source.connection.runtimeID !== runtimeID ||
              (selection.environmentID !== undefined &&
                (selection.environmentID ?? null) !== (resolution.session.environmentID ?? null)) ||
              (selection.workspaceID !== undefined &&
                (selection.workspaceID ?? null) !== (resolution.session.workspaceID ?? null)) ||
              (selection.workspaceGeneration !== undefined &&
                selection.workspaceGeneration !== resolution.session.workspace?.generation)
            )
              denied("Native-only metadata changed its original enrolled Session selection")
            const selected = resolution.description.grant.selection.infrastructure
            resolution.assertConnection()
            return Boolean(selected.workspace || selected.environment)
          },
        )
      },
      async open(input) {
        const origin = input.origin,
          caller = origin.value
        if (
          caller.kind !== "session" ||
          caller.sessionID !== input.selection.ownerID ||
          caller.scopeID !== input.selection.scopeID
        )
          denied("Organization execution requires its genuine native Session/Run/tool origin")
        const nativeOperationID = EnvironmentExecution.operationID(caller)
        return withMemberEnvironment(
          { sessionID: caller.sessionID, scopeID: caller.scopeID, origin, signal: input.signal },
          async (resolution, signal) => {
            const selected = resolution.description.grant.selection.infrastructure
            if (!selected.workspace && !selected.environment) return
            if (!selected.workspace || !selected.environment)
              denied("Organization execution requires an explicit Workspace and Environment pair")
            if (
              input.selection.environmentID !== undefined &&
              input.selection.environmentID !== resolution.session.environmentID
            )
              denied("Environment resolution changed its original native selection")
            if (
              input.selection.workspaceID !== undefined &&
              input.selection.workspaceID !== resolution.session.workspaceID
            )
              denied("Environment resolution changed its original Working selection")
            if (
              input.selection.workspaceGeneration !== undefined &&
              input.selection.workspaceGeneration !== resolution.session.workspace?.generation
            )
              denied("Environment resolution changed its original Working generation")
            if (resolution.source.connection.runtimeID !== runtimeID)
              denied("Environment resolution changed its original enrolled Home")
            const accepted = structuredClone(resolution.accepted)
            const send = resolution.source.resources.environmentOperation.bind(resolution.source.resources)
            const proof = resolution.source.intake.bindingProof.bind(resolution.source.intake)
            const bind = resolution.source.resources.bind.bind(resolution.source.resources)
            const files = resolution.source.resources.workspaceFiles.bind(resolution.source.resources)
            const grant = await bind(resolution.proof, signal)
            await resolution.assertCaller("admission")
            if (
              !same(grant.selection, resolution.description.grant.selection) ||
              grant.selectionRevision !== resolution.description.grant.selectionRevision
            )
              denied("The selected infrastructure changed while its original root was binding")
            let rootPath: string | undefined
            let locator: Cloud.FileLocator | undefined
            if (resolution.session.workspaceID) {
              const workspace = await WorkspaceCatalog.get(resolution.session.workspaceID, caller.scopeID)
              if (
                workspace.backend?.provider !== "organization" ||
                workspace.content ||
                workspace.lifecycle !== "active" ||
                workspace.binding.state !== "bound" ||
                workspace.binding.generation !== resolution.session.workspace?.generation
              )
                denied("Organization execution cannot reinterpret an existing native or object Working location")
              locator = Cloud.FileLocator.parse(workspace.backend.spec)
              if (
                locator.orgID !== identity.orgID ||
                locator.projectID !== caller.scopeID ||
                locator.deploymentIncarnation !== grant.deploymentIncarnation ||
                locator.resourceID !== selected.workspace.resourceID ||
                locator.workspaceID !== selected.workspace.workspaceID
              )
                denied("The Working Locator differs from the accepted service selection")
              rootPath = locator.path
            }
            const described = await files(
              await proof(accepted.actor, accepted.rootID),
              { operation: { action: "describe" } },
              signal,
            )
            await resolution.assertCaller("admission")
            const workspace = Cloud.FileReference.parse({
              ...described.reference,
              ...(rootPath !== undefined && { rootPath }),
            })
            if (
              workspace.resourceID !== selected.workspace.resourceID ||
              workspace.workspaceID !== selected.workspace.workspaceID
            )
              denied("Environment resolution described another selected Workspace")
            if (locator && workspace.generation !== locator.generation)
              denied("The original service Working generation changed")
            const admission: { close(): Promise<void> } = {
              async close() {
                unknown("Original Environment admission has no confirmed reference; reconcile its original grant")
              },
            }
            unresolved.add(admission)
            let resolved: Protocol.Result
            try {
              resolved = await send(
                await proof(accepted.actor, accepted.rootID),
                {
                  action: "resolve",
                  nativeOperationID,
                  capability: input.needs.execution,
                  origin: caller,
                  workspace,
                },
                signal,
              )
            } catch (error) {
              if (error instanceof OrganizationRuntimeError && error.data.outcome === "not_dispatched")
                unresolved.delete(admission)
              throw error
            }
            const ref = Protocol.Reference.parse(resolved.reference)
            admission.close = async () => {
              resolution.assertConnection()
              origin.assertCurrent()
              const authority = Leases.reference(resolution.proof)
              const query = { kind: "admission" as const, reference: ref, origin: caller }
              const result = await retireMemberEnvironment(
                authority,
                { grantID: ref.grantID, generation: ref.retentionGeneration },
                query,
              )
              if (result.kind !== "admission" || !result.released)
                unknown("Original Environment admission release is unconfirmed")
              resolution.assertConnection()
              origin.assertCurrent()
              unresolved.delete(admission)
            }
            try {
              const binding = Binding.parse({
                version: 2,
                reference: ref,
                authority: Leases.reference(resolution.proof),
                scopeID: caller.scopeID,
                origin: caller,
                grantID: grant.grantID,
                generation: grant.retention.generation,
              })
              const mount = WorkspaceProtocol.Mount.parse(ref.mount)
              const runtime = ExecutionProtocol.Description.parse(resolved.runtime)
              if (ref.nativeOperationID !== nativeOperationID || runtime.preparationVersion !== 1)
                denied("Selected Environment does not support the original durable preparation protocol")
              const paths = runtime.platform === "win32" ? path.win32 : path.posix
              const relative = paths.relative(mount.path, ref.directory)
              if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + paths.sep))
                unknown("The actual Environment directory escaped its original mounted Working location")
              let admitted = true
              const operations = new Map<string, { digest: string; intentDigest?: string }>()
              const checked = () => {
                resolution.assertConnection()
                origin.assertCurrent()
              }
              const retired = (result: Protocol.RetirementResult) =>
                result.kind === "admission" ? result.released : result.execution !== null
              const retirement = async (query: Protocol.RetirementQuery) => {
                checked()
                const observed = await inspectMemberEnvironmentRetirement(binding.authority, binding, query)
                checked()
                if (retired(observed)) return observed
                const result = await retireMemberEnvironment(binding.authority, binding, query)
                checked()
                if (!retired(result)) unknown("Original Environment retirement has no confirmed native completion")
                return result
              }
              const retireOperation = async (id: string, digest: string) => {
                const result = await retirement({
                  kind: "execution",
                  reference: ref,
                  id,
                  digest,
                  origin: binding.origin,
                })
                if (result.kind !== "execution" || result.execution === null)
                  unknown("Original Environment retirement returned no native completion")
                const completed = await mirror(binding, id, digest, result.execution)
                if (
                  completed.state !== "completed" ||
                  !completed.status ||
                  !ExecutionProtocol.terminal(completed.status) ||
                  completed.outputCursor !== completed.status.cursor
                )
                  unknown("Original Environment retirement returned an incomplete native receipt")
                return completed
              }
              const perform = async (
                operation: Protocol.Operation,
                phase: "admission" | "mutation",
                cancellation?: AbortSignal,
              ) => {
                checked()
                await resolution.assertCaller(phase)
                const authority = await proof(accepted.actor, accepted.rootID)
                checked()
                const result = await send(authority, operation, cancellation ?? resolution.source.signal)
                checked()
                await resolution.assertCaller(phase)
                return result
              }
              const inspect = async (
                id: string,
                digest: string,
                after = 0,
                limit = 128,
                cancellation?: AbortSignal,
              ) => {
                checked()
                const result = await inspectMemberEnvironment(
                  binding.authority,
                  binding,
                  {
                    kind: "execution",
                    reference: ref,
                    id,
                    digest,
                    origin: binding.origin,
                    after,
                    limit,
                  },
                  cancellation,
                )
                checked()
                if (result.kind !== "execution") unknown("Execution inspection returned another native receipt kind")
                const info = result.execution === null ? undefined : await mirror(binding, id, digest, result.execution)
                const output = z.array(ExecutionProtocol.Chunk).parse(result.output)
                checked()
                return { info, output }
              }
              const inspectPreparation = async () => {
                checked()
                const result = await inspectMemberEnvironment(binding.authority, binding, {
                  kind: "preparation",
                  reference: ref,
                  id: nativeOperationID,
                  origin: binding.origin,
                })
                checked()
                if (result.kind !== "preparation" || result.preparation === null)
                  unknown("Original Environment preparation has no confirmed native receipt")
                const observed = ExecutionProtocol.Preparation.parse(result.preparation)
                const physical = await Protocol.operationIdentity(ref, nativeOperationID, binding.origin)
                checked()
                if (observed.id !== physical.operationID || !Environment.sameTarget(observed.target, runtime.target))
                  unknown("Preparation inspection returned another original native allocation or operation")
                return observed
              }
              const known = (id: string) => {
                const operation = operations.get(id)
                if (!operation) denied("The original live Environment did not accept this operation")
                return operation
              }
              const release = async () => {
                checked()
                if (!admitted) return
                await retirement({ kind: "admission", reference: ref, origin: binding.origin })
                admitted = false
              }
              admission.close = async () => {
                await release()
                unresolved.delete(admission)
              }
              const sourceOperations: Source.Operations = {
                async start(request) {
                  checked()
                  if (request.id !== nativeOperationID) denied("Execution changed its original native tool operation")
                  if (!admitted || !same(request.origin.value, caller))
                    denied("Environment admission has closed or changed its original caller")
                  const previous = operations.get(request.id)
                  if (previous) {
                    if (previous.digest !== request.digest || previous.intentDigest !== request.intentDigest)
                      denied("An original Environment operation cannot change its body")
                    const observed = await inspect(request.id, request.digest)
                    return observed.info ?? unknown("The original Environment start has no confirmed receipt")
                  }
                  operations.set(request.id, { digest: request.digest, intentDigest: request.intentDigest })
                  const command = ExecutionProtocol.Command.parse(request.command)
                  const result = await perform(
                    {
                      action: "start",
                      reference: ref,
                      id: request.id,
                      origin: caller,
                      request: ExecutionProtocol.Request.parse({
                        id: request.id,
                        digest: request.digest,
                        target: runtime.target,
                        command: Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined)),
                      }),
                      ...(request.intentDigest && { intentDigest: request.intentDigest }),
                    },
                    "admission",
                    request.signal,
                  )
                  const info = await mirror(binding, request.id, request.digest, result.value)
                  checked()
                  return info
                },
                async inspect(id) {
                  const operation = known(id)
                  return (await inspect(id, operation.digest)).info
                },
                async output(id, after, limit) {
                  const operation = known(id)
                  return (await inspect(id, operation.digest, after, limit)).output
                },
                async complete(id) {
                  const operation = known(id),
                    observed = await inspect(id, operation.digest)
                  if (observed.info?.state === "completed") return observed.info
                  if (!ProcessAccessSource.hasCurrent()) return retireOperation(id, operation.digest)
                  const result = await perform(
                    { action: "complete", reference: ref, id, digest: operation.digest },
                    "mutation",
                  )
                  const info = await mirror(binding, id, operation.digest, result.value)
                  checked()
                  return info
                },
                async cancel(id, digest) {
                  if (known(id).digest !== digest) denied("Environment cancellation changed its original command")
                  if (!ProcessAccessSource.hasCurrent()) {
                    await retireOperation(id, digest)
                    return
                  }
                  await ProcessAccessSource.recheckCurrent()
                  await perform({ action: "cancel", reference: ref, id, digest }, "mutation")
                },
                async stdin(id, data, end) {
                  known(id)
                  if (!ProcessAccessSource.hasCurrent())
                    denied("Environment process input requires its current genuine Process caller")
                  await ProcessAccessSource.recheckCurrent()
                  const bytes = Uint8Array.from(data)
                  await perform(
                    { action: "stdin", reference: ref, id, data: Buffer.from(bytes).toString("base64"), end },
                    "mutation",
                  )
                },
                async resize(id, cols, rows) {
                  known(id)
                  if (!ProcessAccessSource.hasCurrent())
                    denied("Environment process resizing requires its current genuine Process caller")
                  await ProcessAccessSource.recheckCurrent()
                  await perform({ action: "resize", reference: ref, id, cols, rows }, "mutation")
                },
              }
              const executor: Executor = {
                async describe() {
                  checked()
                  return runtime
                },
                async inspectPreparation(id) {
                  if (id !== nativeOperationID) denied("Preparation inspection changed its original native identity")
                  return inspectPreparation()
                },
                async prepareInputs(value) {
                  const input = ExecutionProtocol.Inputs.parse(value)
                  if (input.id !== nativeOperationID)
                    denied("Input preparation changed its original native tool identity")
                  const result = await perform(
                    { action: "prepare-inputs", reference: ref, id: nativeOperationID, input },
                    "admission",
                  )
                  return ExecutionProtocol.PreparedInputs.parse(result.value)
                },
                async discardInputs(id) {
                  if (id !== nativeOperationID) denied("Input cleanup changed its original native identity")
                  await perform({ action: "discard-inputs", reference: ref, id }, "mutation")
                },
                async prepareSandbox(value) {
                  const { operationID, ...input } = ExecutionProtocol.SandboxInput.parse(value)
                  if (operationID !== undefined && operationID !== nativeOperationID)
                    denied("Sandbox preparation changed its original tool identity")
                  const policy = JsonValue.parse(
                    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
                  )
                  const result = await perform(
                    { action: "prepare-sandbox", reference: ref, id: nativeOperationID, input: policy },
                    "admission",
                  )
                  return ExecutionProtocol.Sandbox.parse(result.value)
                },
                async releaseSandbox(id) {
                  await perform({ action: "release-sandbox", reference: ref, id }, "mutation")
                },
                async start(request) {
                  const info = await sourceOperations.start({
                    ...request,
                    scopeID: caller.scopeID,
                    origin,
                    workspaces: [WorkspaceProtocol.Reference.parse(mount)],
                  })
                  return info.status ?? unknown("The original remote start has no native status")
                },
                async status(id) {
                  return (await sourceOperations.inspect(id))?.status
                },
                async output(id, after = 0, limit = 128) {
                  return sourceOperations.output(id, after, limit)
                },
                cancel: sourceOperations.cancel,
                async stdin(id, data, end = false) {
                  await sourceOperations.stdin(id, data, end)
                },
                resize: sourceOperations.resize,
                async release(id) {
                  await sourceOperations.complete(id)
                },
              }
              const owned = {
                async close() {
                  const cancellation = AbortSignal.timeout(15_000)
                  for (const [id, operation] of operations) {
                    cancellation.throwIfAborted()
                    await retireOperation(id, operation.digest)
                    await EnvironmentExecution.reconcile(id, caller.scopeID)
                    await EnvironmentExecution.complete(id, caller.scopeID)
                  }
                  await release()
                  live.delete(owned)
                },
              }
              live.add(owned)
              unresolved.delete(admission)
              admission.close = async () => {
                await release()
                live.delete(owned)
              }
              await resolution.assertCaller("admission")
              if (
                ref.grantID !== grant.grantID ||
                ref.retentionGeneration !== grant.retention.generation ||
                ref.selectionRevision !== grant.selectionRevision ||
                ref.resourceID !== selected.environment.resourceID ||
                ref.environmentID !== selected.environment.environmentID ||
                !Environment.sameTarget(runtime.target, Environment.Target.parse(ref.target)) ||
                mount.workspaceID !== selected.workspace.workspaceID ||
                mount.generation <= 0 ||
                runtime.directory.length === 0
              )
                denied("Environment resolution changed its selected resource, native mount or allocation")
              checked()
              return {
                target: runtime.target,
                runtime,
                directory: ref.directory,
                binding,
                executor,
                workspaces: [WorkspaceProtocol.Reference.parse(mount)],
                useRoots: [mount.path],
                operations: sourceOperations,
                assert() {
                  checked()
                  if (!admitted) denied("Environment admission has ended")
                },
                release,
              }
            } catch (error) {
              try {
                await admission.close()
              } catch (failure) {
                throw new AggregateError([error, failure], "Environment resolution and original cleanup failed", {
                  cause: error,
                })
              }
              throw error
            }
          },
        )
      },
      async inspect(input) {
        const binding = retained(input.binding, identity, runtimeID, input.scopeID, input.origin)
        if (!Environment.sameTarget(input.target, Environment.Target.parse(binding.reference.target)))
          denied("Environment inspection changed its original actual target")
        if (input.operationID !== binding.reference.nativeOperationID)
          denied("Environment inspection changed its original native operation")
        const observed = await inspectMemberEnvironment(
          binding.authority,
          binding,
          {
            kind: "execution",
            reference: binding.reference,
            id: input.operationID,
            digest: input.digest,
            origin: binding.origin,
            after: input.after,
            limit: input.limit,
          },
          input.signal,
        )
        if (observed.kind !== "execution") unknown("Retained execution inspection returned another receipt kind")
        return {
          info:
            observed.execution === null
              ? undefined
              : await mirror(binding, input.operationID, input.digest, observed.execution),
          output: z.array(ExecutionProtocol.Chunk).parse(observed.output),
        }
      },
      async close() {
        const results = await Promise.allSettled([...unresolved, ...live].map((lease) => lease.close()))
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length)
          throw new AggregateError(failures, "Original Environment execution sources remain retained")
      },
    })
  }
}
