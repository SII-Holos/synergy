import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffObjectProtocol as Objects,
  OrganizationCloudProtocol as Cloud,
  OrganizationSessionToolProtocol as SessionTool,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRuntimeError } from "./error"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"

export interface MemberResourceClient {
  inspectWorkspaceFile(
    proof: Execution.InspectionProof,
    input: { reference: Cloud.FileReference; operation: Cloud.FileInspectionProof["operation"] },
    signal?: AbortSignal,
  ): Promise<Cloud.FileResult>
  handoffWorkspace(
    plan: Handoff.MachinePlan,
    operation: Cloud.HandoffWorkspaceOperation,
    signal?: AbortSignal,
  ): Promise<Cloud.HandoffWorkspaceResult>
  workspaceFiles(
    proof: Execution.BindingProof,
    input: Cloud.LocalFileRequest,
    signal?: AbortSignal,
  ): Promise<Cloud.FileResult>
  handoffObject(
    reference: HandoffObjectReference,
    range: z.infer<typeof Handoff.ObjectRange>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Handoff.ObjectChunk>>
  handoffInventory(
    proof: Execution.HandoffInventoryProof,
    signal?: AbortSignal,
  ): Promise<Execution.HandoffInventoryPage>
  closeHandoff(proof: Execution.HandoffCloseProof, signal?: AbortSignal): Promise<Execution.HandoffCloseReceipt>
  retention(proof: Execution.DescriptionProof, signal?: AbortSignal): Promise<Execution.Grant>
  inspectRetention(proof: Execution.InspectionProof, signal?: AbortSignal): Promise<Execution.Inspection>
  describe(proof: Execution.DescriptionProof, signal?: AbortSignal): Promise<Execution.Description>
  bind(proof: Execution.BindingProof, signal?: AbortSignal): Promise<Execution.BoundGrant>
  release(proof: Execution.ReleaseProof, signal?: AbortSignal): Promise<Execution.ReleaseReceipt>
  reserve(proof: Gateway.Proof, signal?: AbortSignal): Promise<Gateway.SignedPermit>
  inspect(proof: Gateway.Proof, signal?: AbortSignal): Promise<Gateway.Receipt>
  invoke(
    permit: Gateway.SignedPermit,
    input?: { body?: string | Uint8Array | ArrayBuffer; signal?: AbortSignal },
  ): Promise<Response>
  invokeMcp(permit: Gateway.SignedPermit, input: Gateway.McpRequest, signal?: AbortSignal): Promise<Gateway.McpResult>
  knowledge(
    proof: Execution.DescriptionProof,
    query?: { cursor?: string; manifestHash?: string },
    signal?: AbortSignal,
  ): Promise<Knowledge.ExecutionPage>
  sessionRead(
    proof: Execution.DescriptionProof,
    query: SessionTool.ReadQuery,
    signal?: AbortSignal,
  ): Promise<SessionTool.ReadResult>
  knowledgeFiles(
    proof: Execution.DescriptionProof,
    reference: Knowledge.Reference,
    query?: { cursor?: string; activatedManifestHash?: string },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Publication.FilePage>>
  knowledgeContent(
    proof: Execution.DescriptionProof,
    reference: Knowledge.Reference,
    fileID: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
    activatedManifestHash?: string,
  ): Promise<Knowledge.ContentChunk>
  activateKnowledge(
    proof: Execution.DescriptionProof,
    selection: { manifestHash: string; revision: number; outcome?: "activated" | "failed" },
    signal?: AbortSignal,
  ): Promise<Knowledge.ActivationReceipt>
  activatedKnowledge(
    proof: Execution.DescriptionProof,
    query: { manifestHash: string; cursor?: string },
    signal?: AbortSignal,
  ): Promise<Knowledge.ExecutionPage>
}

export type HandoffObjectReference = Pick<
  Objects.Proof,
  | "schemaVersion"
  | "orgID"
  | "deploymentIncarnation"
  | "handoffID"
  | "sessionID"
  | "sourceRuntimeID"
  | "targetRuntimeID"
  | "fromEpoch"
  | "toEpoch"
  | "mappingPlanRevision"
  | "shareGeneration"
  | "manifestHash"
>

type Proof =
  | Execution.DescriptionProof
  | Execution.BindingProof
  | Execution.ReleaseProof
  | Execution.HandoffInventoryProof
  | Execution.HandoffCloseProof
  | Execution.InspectionProof
  | Gateway.Proof
  | Objects.Proof
  | Cloud.HandoffWorkspaceProof

function failure(
  code: OrganizationProtocol.Error["code"],
  message: string,
  outcome: OrganizationProtocol.Error["outcome"] = "unknown",
) {
  return new OrganizationRuntimeError({ code, message, outcome, retryable: false })
}

export function createMemberResourceClient(options: {
  origin: string
  connection: z.infer<typeof Runtime.Connected>
  key: CryptoKey
  ca?: string | string[]
  signal: AbortSignal
}) {
  const connection = Runtime.Connected.parse(options.connection)
  const url = new URL(options.origin)
  if (url.protocol !== "https:" || url.origin !== options.origin)
    throw failure("PROTOCOL_MISMATCH", "Resource control requires the verified organization origin", "not_dispatched")
  const stop = new AbortController()
  const lifetime = AbortSignal.any([stop.signal, options.signal])
  const active = new Set<Promise<unknown>>()
  const bodies = new Set<{ reader: ReadableStreamDefaultReader<Uint8Array>; done: Promise<void> }>()
  const waiters = new Set<() => void>()
  let occupied = 0
  let closing: Promise<void> | undefined
  // Provenance: https://bun.sh/docs/runtime/networking/fetch#fetch-sessions
  // Local adaptation: cancel and drain active bodies before closing this connection's private idle pool.
  const transport = new Bun.FetchSession({ tls: { ca: options.ca, rejectUnauthorized: true }, proxy: false })
  const client = createOrganizationClient({
    baseUrl: options.origin,
    credentials: "omit",
    redirect: "error",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await transport.fetch(input, { ...init, credentials: "omit", redirect: "error" })
        const reader = response.body?.getReader()
        if (!reader) return response
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        let aborting: Promise<void> | undefined
        const abort = () => {
          aborting ??= reader.cancel().catch(() => {})
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          const pathname = new URL(input instanceof Request ? input.url : String(input), options.origin).pathname
          const maximum =
            pathname === "/runtime/v1/workspaces/files" || pathname === "/runtime/v1/handoffs/workspace"
              ? 6 * 1024 * 1024
              : /\/runtime\/v1\/gateway\/connections\/[^/]+\/mcp$/.test(pathname)
                ? 16 * 1024 * 1024
                : 256 * 1024
          while (true) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > maximum)
              throw failure("PROTOCOL_MISMATCH", "Organization resource control response exceeded its format limit")
            chunks.push(next.value)
          }
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        } finally {
          signal?.removeEventListener("abort", abort)
          await aborting
          reader.releaseLock()
        }
        return new Response(Buffer.concat(chunks, bytes), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      },
      { preconnect() {} },
    ),
  })
  function current(proof: Proof) {
    lifetime.throwIfAborted()
    if (
      proof.orgID !== connection.orgID ||
      proof.deploymentIncarnation !== connection.deploymentIncarnation ||
      proof.runtimeID !== connection.runtimeID ||
      proof.connectionEpoch !== connection.connectionEpoch
    )
      throw failure("STALE_CONNECTION", "Resource proof does not match this member connection", "not_dispatched")
    if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
      throw failure("PERMISSION_DENIED", "Resource proof is outside its validity window", "not_dispatched")
  }
  async function acquire(signal: AbortSignal) {
    while (occupied >= 8) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          waiters.delete(changed)
          signal.removeEventListener("abort", aborted)
          resolve()
        }
        const aborted = () => {
          waiters.delete(changed)
          signal.removeEventListener("abort", aborted)
          reject(signal.reason)
        }
        waiters.add(changed)
        signal.addEventListener("abort", aborted, { once: true })
        if (signal.aborted) aborted()
      })
    }
    signal.throwIfAborted()
    occupied++
  }
  function release() {
    occupied--
    for (const wake of [...waiters]) wake()
  }
  function invoke<T>(
    proof: Proof,
    schema: z.ZodType<T>,
    request: (signal: AbortSignal) => Promise<{ data?: unknown; error?: unknown }>,
    verify: (result: T) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<T> {
    current(proof)
    const cancellation = AbortSignal.any([
      lifetime,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(0, Math.min(15_000, proof.expiresAt - Date.now()))),
    ])
    const pending = (async () => {
      await acquire(cancellation)
      try {
        current(proof)
        const response = await request(cancellation)
        cancellation.throwIfAborted()
        if (!response.data) {
          if (response.error instanceof Error) throw response.error
          const error = OrganizationProtocol.Error.safeParse(response.error)
          throw error.success
            ? new OrganizationRuntimeError(error.data)
            : failure("PROTOCOL_MISMATCH", "Organization resource control returned an invalid response")
        }
        const parsed = schema.safeParse(response.data)
        if (!parsed.success)
          throw failure("PROTOCOL_MISMATCH", "Organization resource control returned an invalid response")
        await verify(parsed.data)
        cancellation.throwIfAborted()
        return parsed.data
      } catch (error) {
        cancellation.throwIfAborted()
        if (error instanceof OrganizationRuntimeError) throw error
        throw failure("SERVICE_UNAVAILABLE", "Organization resource control response is unavailable")
      } finally {
        release()
      }
    })()
    active.add(pending)
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }
  function grant(proof: Pick<Execution.DescriptionProof, "receipt" | "continuation">, value: Execution.Grant) {
    const permit = proof.receipt.accepted!.permit
    const control = proof.continuation?.receipt.accepted
    const authority = control?.permit ?? permit
    if (
      value.orgID !== permit.orgID ||
      value.deploymentIncarnation !== permit.deploymentIncarnation ||
      value.runtimeID !== authority.runtimeID ||
      value.sessionID !== permit.sessionID ||
      value.projectID !== permit.projectID ||
      value.bindingEpoch !== authority.bindingEpoch ||
      value.admissionID !== permit.admissionID ||
      value.attemptID !== permit.attemptID ||
      JSON.stringify(value.actor) !== JSON.stringify(permit.actor) ||
      (value.state === "bound" && value.rootID !== proof.receipt.accepted!.effect.messageID) ||
      (control
        ? value.grantID === permit.provisionalGrantID ||
          value.provenance?.originGrantID !== permit.provisionalGrantID ||
          value.provenance?.handoffID !== proof.continuation!.handoffID ||
          value.provenance?.rootID !== proof.receipt.accepted!.effect.messageID ||
          JSON.stringify(value.provenance?.control) !== JSON.stringify(control)
        : value.grantID !== permit.provisionalGrantID || value.provenance !== undefined)
    )
      throw failure(
        "PROTOCOL_MISMATCH",
        "Organization execution grant does not match its accepted task and current control",
      )
  }
  function sameHandoff(
    proof: Execution.HandoffInventoryProof | Execution.HandoffCloseProof,
    value: z.infer<typeof Handoff.Binding>,
  ) {
    if (
      Object.keys(Handoff.Binding.shape).some((key) => {
        const field = key as keyof z.infer<typeof Handoff.Binding>
        return proof[field] !== value[field]
      })
    )
      throw failure("PROTOCOL_MISMATCH", "Resource handoff response belongs to another exact binding")
  }
  function target(proof: Gateway.Proof, value: Gateway.Target) {
    if (
      value.connectionEpoch > proof.connectionEpoch ||
      (Object.keys(Gateway.Target.shape) as (keyof Gateway.Target)[]).some(
        (key) => key !== "connectionEpoch" && value[key] !== proof[key],
      )
    )
      throw failure("PROTOCOL_MISMATCH", "Organization resource call does not match its requested target")
  }
  async function connectionPermit(value: Gateway.SignedPermit) {
    const signed = Gateway.SignedPermit.parse(value)
    const parsed = Gateway.ConnectionPermit.safeParse(signed.permit)
    if (!parsed.success)
      throw failure(
        "PROTOCOL_MISMATCH",
        "Organization connection capability is not a business resource",
        "not_dispatched",
      )
    const permit = { permit: parsed.data, signature: signed.signature }
    lifetime.throwIfAborted()
    if (
      permit.permit.orgID !== connection.orgID ||
      permit.permit.deploymentIncarnation !== connection.deploymentIncarnation ||
      permit.permit.runtimeID !== connection.runtimeID ||
      permit.permit.connectionEpoch !== connection.connectionEpoch ||
      permit.permit.keyID !== connection.signingIdentity.keyID ||
      !(await Gateway.verifyPermit(permit.permit, permit.signature, connection.signingIdentity.publicKey))
    )
      throw failure(
        "STALE_CONNECTION",
        "Organization connection capability does not match this member connection",
        "not_dispatched",
      )
    if (permit.permit.issuedAt > Date.now() || permit.permit.expiresAt <= Date.now())
      throw failure("PERMISSION_DENIED", "Organization connection capability has expired", "not_dispatched")
    return permit
  }
  const resources: MemberResourceClient = {
    async inspectWorkspaceFile(value, input, signal) {
      const proof = Execution.InspectionProof.parse(value)
      const selected = Cloud.LocalFileRequest.parse(input)
      if (selected.operation.action !== "receipt" && selected.operation.action !== "acknowledge")
        throw failure("PROTOCOL_MISMATCH", "File inspection cannot dispatch an operation", "not_dispatched")
      const file = Cloud.FileInspectionProof.parse({
        purpose: "organization-workspace-file-inspection",
        authority: { proof, signature: await Execution.signInspection(proof, options.key) },
        ...selected,
      })
      const request = Cloud.FileInspectionRequest.parse({
        proof: file,
        signature: await Cloud.signFileInspection(file, options.key),
      })
      return invoke(
        proof,
        Cloud.FileResult,
        (signal) => client.orgCloudFiles.inspect({ orgCloudFileInspectionRequest: request }, { signal }),
        (result) => {
          if (
            JSON.stringify(result.reference) !== JSON.stringify(selected.reference) ||
            result.result.action !== selected.operation.action
          )
            throw failure("PROTOCOL_MISMATCH", "File inspection returned another original receipt")
          const answer = result.result
          const matches = (mount: z.infer<typeof Cloud.FileCheckpoint>["mount"]) =>
            mount.id === file.reference.workspaceID &&
            mount.workspaceID === file.reference.workspaceID &&
            mount.generation === file.reference.generation
          if (
            answer.action === "receipt" &&
            answer.status &&
            (answer.status.id !== file.operation.id ||
              !matches(answer.status.mount) ||
              (answer.status.checkpoint &&
                (answer.status.checkpoint.id !== file.operation.id || !matches(answer.status.checkpoint.mount))) ||
              (answer.status.state === "saved" && !answer.status.checkpoint))
          )
            throw failure("PROTOCOL_MISMATCH", "File inspection returned another original checkpoint")
          if (answer.action === "acknowledge" && answer.id !== file.operation.id)
            throw failure("PROTOCOL_MISMATCH", "File inspection acknowledged another operation")
        },
        signal,
      )
    },
    async handoffWorkspace(value, input, signal) {
      const plan = Handoff.MachinePlan.parse(value)
      const operation = Cloud.HandoffWorkspaceOperation.parse(input)
      const workspace = plan.workspacePlan
      if (!workspace || workspace.mapping.kind === "native" || !workspace.targetScopeID || !workspace.selectionActor)
        throw failure("HANDOFF_BLOCKED", "Workspace transfer requires its complete original mapping", "not_dispatched")
      const mapping = workspace.mapping
      const original =
        mapping.kind === "organization-object"
          ? WorkspaceMove.Request.parse({
              id: mapping.moveID,
              source: { ...mapping.source, scopeID: plan.sourceBinding.projectID },
              target: {
                workspaceID: mapping.target.workspaceID,
                generation: mapping.target.generation,
                scopeID: workspace.targetScopeID,
                path: mapping.target.path,
                expectedRevision: mapping.target.expectedRevision,
              },
              mappingRevision: plan.mappingPlanRevision,
              acceptedDiffHash: mapping.acceptedDiffHash,
              actor: workspace.selectionActor,
            })
          : undefined
      const issuedAt = Date.now()
      const proof = Cloud.HandoffWorkspaceProof.parse({
        ...Object.fromEntries(
          Object.keys(Handoff.Binding.shape).map((key) => [key, plan[key as keyof Handoff.MachinePlan]]),
        ),
        purpose: "handoff-workspace",
        runtimeID: connection.runtimeID,
        connectionEpoch: connection.connectionEpoch,
        mappingHash: workspace.hash,
        operation,
        issuedAt,
        expiresAt: issuedAt + 30_000,
      })
      const request = Cloud.HandoffWorkspaceRequest.parse({
        proof,
        signature: await Cloud.signHandoffWorkspace(proof, options.key),
      })
      return invoke(
        proof,
        Cloud.HandoffWorkspaceResult,
        (signal) => client.orgHandoffWorkspace.request({ orgHandoffWorkspaceRequest: request }, { signal }),
        (result) => {
          if (
            result.action !== operation.action ||
            (result.action === "put" && (operation.action !== "put" || result.hash !== operation.hash))
          )
            throw failure("PROTOCOL_MISMATCH", "Workspace transfer returned another original operation")
          if (result.action === "source" || result.action === "source-validate") {
            if (mapping.kind !== "organization-live" && mapping.kind !== "organization-native")
              throw failure("PROTOCOL_MISMATCH", "Workspace source changed its selected mapping")
            const snapshot = WorkspaceArchive.Subtree.parse(result.snapshot)
            if (
              snapshot.workspaceID !== mapping.resource.workspaceID ||
              snapshot.generation !== mapping.resource.generation ||
              snapshot.scopeID !== workspace.targetScopeID ||
              snapshot.path !== mapping.resource.path ||
              snapshot.manifest !== WorkspaceTree.hash(new TextEncoder().encode(JSON.stringify(snapshot.files))) ||
              (plan.frozen?.proof.purpose === "source-frozen" &&
                plan.frozen.proof.workspaceSourceHash !== WorkspaceArchive.subtreeHash(snapshot))
            )
              throw failure(
                "PROTOCOL_MISMATCH",
                "Workspace source snapshot differs from its original service selection",
              )
            return
          }
          if (result.action === "source-object") {
            if (operation.action !== "source-object" || result.hash !== operation.hash)
              throw failure("PROTOCOL_MISMATCH", "Workspace source returned another object")
            const bytes = Buffer.from(result.data, "base64")
            if (bytes.toString("base64") !== result.data)
              throw failure("PROTOCOL_MISMATCH", "Workspace source object encoding changed")
            WorkspaceTree.verify(result.hash, bytes, operation.maximumBytes)
            return
          }
          if (!original) throw failure("PROTOCOL_MISMATCH", "Live Workspace source cannot publish a move")
          const receipt =
            result.action === "publish" || result.action === "validate"
              ? WorkspaceMove.Receipt.parse(result.receipt)
              : result.action === "inspect" && result.status !== undefined
                ? WorkspaceMove.Status.parse(result.status).receipt
                : undefined
          if (result.action === "inspect" && result.status !== undefined) {
            const status = WorkspaceMove.Status.parse(result.status)
            if (
              JSON.stringify(status.request) !== JSON.stringify(original) ||
              status.digest !== WorkspaceMove.requestHash(original)
            )
              throw failure("PROTOCOL_MISMATCH", "Workspace transfer status has another original request")
          }
          if (
            receipt &&
            (receipt.id !== original.id ||
              receipt.requestHash !== WorkspaceMove.requestHash(original) ||
              (operation.action === "publish" &&
                receipt.source.manifest !== WorkspaceMove.CapturedSource.parse(operation.source).manifest) ||
              (plan.frozen?.proof.purpose === "source-frozen" &&
                WorkspaceMove.receiptHash(receipt) !== plan.frozen.proof.workspaceMoveReceiptHash))
          )
            throw failure("PROTOCOL_MISMATCH", "Workspace transfer receipt has another original publication")
        },
        signal,
      )
    },
    async workspaceFiles(value, input, signal) {
      const proof = Execution.BindingProof.parse(value)
      const selected = Cloud.LocalFileRequest.parse(input)
      const file = Cloud.FileProof.parse({
        purpose: "organization-workspace-file",
        authority: { proof, signature: await Execution.signBinding(proof, options.key) },
        ...selected,
      })
      const request = Cloud.FileRequest.parse({ proof: file, signature: await Cloud.signFile(file, options.key) })
      return invoke(
        proof,
        Cloud.FileResult,
        (signal) => client.orgCloudFiles.request({ orgCloudFileRequest: request }, { signal }),
        (result) => {
          const ref = result.reference
          const expected = selected.reference
          if (
            ref.orgID !== proof.orgID ||
            ref.projectID !== proof.receipt.accepted!.permit.projectID ||
            result.result.action !== selected.operation.action ||
            (expected &&
              (ref.resourceID !== expected.resourceID ||
                ref.workspaceID !== expected.workspaceID ||
                ref.generation !== expected.generation ||
                ref.rootPath !== expected.rootPath))
          )
            throw failure("PROTOCOL_MISMATCH", "Workspace file response belongs to another original resource")
          const operation = selected.operation
          const id = "id" in operation ? operation.id : undefined
          const mountMatches = (mount: z.infer<typeof Cloud.FileCheckpoint>["mount"]) =>
            expected !== undefined &&
            mount.id === expected.workspaceID &&
            mount.workspaceID === expected.workspaceID &&
            mount.generation === expected.generation
          const checkpointMatches = (checkpoint: z.infer<typeof Cloud.FileCheckpoint>) =>
            checkpoint.id === id && mountMatches(checkpoint.mount)
          const answer = result.result
          if ((answer.action === "write" || answer.action === "mutate") && !checkpointMatches(answer.checkpoint))
            throw failure("PROTOCOL_MISMATCH", "Workspace checkpoint belongs to another original operation")
          if (
            answer.action === "receipt" &&
            answer.status &&
            (answer.status.id !== id ||
              !mountMatches(answer.status.mount) ||
              (answer.status.checkpoint && !checkpointMatches(answer.status.checkpoint)) ||
              (answer.status.state === "saved" && !answer.status.checkpoint))
          )
            throw failure("PROTOCOL_MISMATCH", "Workspace receipt belongs to another original operation")
          if (answer.action === "acknowledge" && answer.id !== id)
            throw failure("PROTOCOL_MISMATCH", "Workspace acknowledgment belongs to another original operation")
          if (result.result.action === "read") {
            const bytes = Buffer.from(result.result.data, "base64")
            if (
              bytes.toString("base64") !== result.result.data ||
              selected.operation.action !== "read" ||
              bytes.length !==
                Math.min(
                  selected.operation.maximumBytes,
                  Math.max(0, result.result.size - selected.operation.offset),
                ) ||
              (selected.operation.expectedVersion !== undefined &&
                selected.operation.expectedVersion !== result.result.version)
            )
              throw failure(
                "PROTOCOL_MISMATCH",
                "Workspace file response does not complete its original version and byte window",
              )
          }
        },
        signal,
      )
    },
    async handoffObject(reference, range, signal) {
      const issuedAt = Date.now()
      const proof = Objects.Proof.parse({
        ...reference,
        purpose: "handoff-object-read",
        runtimeID: connection.runtimeID,
        connectionEpoch: connection.connectionEpoch,
        requestID: crypto.randomUUID(),
        range,
        issuedAt,
        expiresAt: issuedAt + 15_000,
      })
      return invoke(
        proof,
        Handoff.ObjectChunk,
        async (signal) =>
          client.orgHandoffObject.read(
            {
              orgHandoffObjectRequest: { proof, signature: await Objects.sign(proof, options.key) },
            },
            { signal },
          ),
        (result) => {
          if (
            result.hash !== proof.range.hash ||
            result.offset !== proof.range.offset ||
            result.nextOffset - result.offset > proof.range.length
          )
            throw failure("PROTOCOL_MISMATCH", "Handoff object response changed its immutable range")
        },
        signal,
      )
    },
    async activateKnowledge(value, selection, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Knowledge.ActivationReceipt,
        async (signal) =>
          client.orgKnowledgeExecution.activate(
            {
              orgKnowledgeActivationRequest: {
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
                manifestHash: selection.manifestHash,
                revision: selection.revision,
                outcome: selection.outcome,
              },
            },
            { signal },
          ),
        (result) => {
          const target = proof.receipt.accepted!.permit
          if (
            result.orgID !== proof.orgID ||
            result.projectID !== target.projectID ||
            result.sessionID !== target.sessionID ||
            result.manifestHash !== selection.manifestHash ||
            result.revision !== selection.revision
          )
            throw failure("PROTOCOL_MISMATCH", "Knowledge activation does not match this Session selection")
        },
        signal,
      )
    },
    async activatedKnowledge(value, query, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Knowledge.ExecutionPage,
        async (signal) =>
          client.orgKnowledgeExecution.activated(
            {
              orgKnowledgeActivatedQuery: {
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
                limit: 50,
                ...query,
              },
            },
            { signal },
          ),
        (result) => {
          const target = proof.receipt.accepted!.permit
          if (
            result.orgID !== proof.orgID ||
            result.projectID !== target.projectID ||
            result.sessionID !== target.sessionID ||
            result.selection.manifestHash !== query.manifestHash
          )
            throw failure("PROTOCOL_MISMATCH", "Activated knowledge manifest does not match this Session")
        },
        signal,
      )
    },
    async sessionRead(value, input, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      const query = SessionTool.ReadQuery.parse(input)
      return invoke(
        proof,
        SessionTool.ReadResult,
        async (signal) =>
          client.orgSessionTools.read(
            {
              orgSessionToolReadRequest: {
                ...query,
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
              },
            },
            { signal },
          ),
        (result) => {
          const accepted = proof.receipt.accepted!
          if (
            result.orgID !== proof.orgID ||
            result.callerSessionID !== accepted.permit.sessionID ||
            result.rootID !== accepted.effect.messageID ||
            result.targetSessionID !== query.targetSessionID
          )
            throw failure("PROTOCOL_MISMATCH", "Shared history belongs to another Session or accepted task")
        },
        signal,
      )
    },
    async knowledge(value, query = {}, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Knowledge.ExecutionPage,
        async (signal) =>
          client.orgKnowledgeExecution.selection(
            {
              orgKnowledgeExecutionQuery: {
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
                limit: 50,
                ...query,
              },
            },
            { signal },
          ),
        (result) => {
          const target = proof.receipt.accepted!.permit
          if (
            result.orgID !== proof.orgID ||
            result.sessionID !== target.sessionID ||
            result.projectID !== target.projectID
          )
            throw failure("PROTOCOL_MISMATCH", "Knowledge selection belongs to another Session")
        },
        signal,
      )
    },
    async knowledgeFiles(value, reference, query = {}, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Publication.FilePage,
        async (signal) =>
          client.orgKnowledgeExecution.files(
            {
              orgKnowledgeExecutionFiles: {
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
                reference,
                limit: 50,
                ...query,
              },
            },
            { signal },
          ),
        () => {},
        signal,
      )
    },
    async knowledgeContent(value, reference, fileID, offset, length, signal, activatedManifestHash) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Knowledge.ContentChunk,
        async (signal) =>
          client.orgKnowledgeExecution.content(
            {
              orgKnowledgeExecutionContent: {
                authority: { proof, signature: await Execution.signDescription(proof, options.key) },
                reference,
                activatedManifestHash,
                fileID,
                offset,
                length,
              },
            },
            { signal },
          ),
        (result) => {
          if (
            result.fileID !== fileID ||
            result.offset !== offset ||
            Buffer.from(result.data, "base64url").length > length
          )
            throw failure("PROTOCOL_MISMATCH", "Knowledge content does not match its selected file range")
        },
        signal,
      )
    },
    async handoffInventory(value, signal) {
      const proof = Execution.HandoffInventoryProof.parse(value)
      return invoke(
        proof,
        Execution.HandoffInventoryPage,
        async (signal) =>
          client.orgExecution.handoffInventory(
            {
              orgExecutionHandoffInventoryRequest: {
                proof,
                signature: await Execution.signHandoffInventory(proof, options.key),
              },
            },
            { signal },
          ),
        (result) => sameHandoff(proof, result.binding),
        signal,
      )
    },
    async closeHandoff(value, signal) {
      const proof = Execution.HandoffCloseProof.parse(value)
      return invoke(
        proof,
        Execution.HandoffCloseReceipt,
        async (signal) =>
          client.orgExecution.closeHandoff(
            {
              orgExecutionHandoffCloseRequest: {
                proof,
                signature: await Execution.signHandoffClose(proof, options.key),
              },
            },
            { signal },
          ),
        (result) => {
          sameHandoff(proof, result)
          if (
            result.grantID !== proof.grantID ||
            result.rootID !== proof.rootID ||
            result.generation !== proof.generation ||
            result.manifestHash !== proof.manifestHash ||
            result.preparedHash !== proof.preparedHash
          )
            throw failure("PROTOCOL_MISMATCH", "Resource handoff receipt does not match its exact retained generation")
        },
        signal,
      )
    },
    async inspectRetention(value, signal) {
      const proof = Execution.InspectionProof.parse(value)
      return invoke(
        proof,
        Execution.Inspection,
        async (signal) =>
          client.orgExecution.retention(
            {
              orgExecutionRetentionRequest: { proof, signature: await Execution.signInspection(proof, options.key) },
            },
            { signal },
          ),
        (result) => {
          const original = proof.receipt.accepted!
          const control = proof.continuation?.receipt.accepted
          if (
            result.orgID !== proof.orgID ||
            result.deploymentIncarnation !== proof.deploymentIncarnation ||
            result.runtimeID !== proof.runtimeID ||
            result.connectionEpoch !== proof.connectionEpoch ||
            result.sessionID !== original.permit.sessionID ||
            result.bindingEpoch !== (control?.permit.bindingEpoch ?? original.permit.bindingEpoch) ||
            result.rootID !== proof.rootID ||
            result.originGrantID !== original.permit.provisionalGrantID ||
            result.controlAdmissionID !== control?.permit.admissionID ||
            result.requestedGrantID !== proof.grantID ||
            result.requestedGeneration !== proof.generation
          )
            throw failure("PROTOCOL_MISMATCH", "Cleanup inspection belongs to another exact native intent")
          if (result.state === "known") grant(proof, result.grant)
        },
        signal,
      )
    },
    async retention(value, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Execution.Grant,
        async (signal) =>
          client.orgExecution.retention(
            {
              orgExecutionRetentionRequest: { proof, signature: await Execution.signDescription(proof, options.key) },
            },
            { signal },
          ),
        (result) => grant(proof, result),
        signal,
      )
    },
    async describe(value, signal) {
      const proof = Execution.DescriptionProof.parse(value)
      return invoke(
        proof,
        Execution.Description,
        async (signal) =>
          client.orgExecution.resources(
            {
              orgExecutionDescriptionRequest: { proof, signature: await Execution.signDescription(proof, options.key) },
            },
            { signal },
          ),
        (result) => grant(proof, result.grant),
        signal,
      )
    },
    async bind(value, signal) {
      const proof = Execution.BindingProof.parse(value)
      return invoke(
        proof,
        Execution.BoundGrant,
        async (signal) =>
          client.orgExecution.bind(
            { orgExecutionBindingRequest: { proof, signature: await Execution.signBinding(proof, options.key) } },
            { signal },
          ),
        (result) => {
          grant(proof, result)
          if (result.retention.state !== "held")
            throw failure("PROTOCOL_MISMATCH", "Execution binding did not retain its resources")
        },
        signal,
      )
    },
    async release(value, signal) {
      const proof = Execution.ReleaseProof.parse(value)
      return invoke(
        proof,
        Execution.ReleaseReceipt,
        async (signal) =>
          client.orgExecution.release(
            { orgExecutionReleaseRequest: { proof, signature: await Execution.signRelease(proof, options.key) } },
            { signal },
          ),
        (result) => {
          const permit = proof.receipt.accepted!.permit
          const current = proof.continuation?.receipt.accepted?.permit ?? permit
          if (
            result.grantID !== (proof.grantID ?? permit.provisionalGrantID) ||
            result.orgID !== permit.orgID ||
            result.deploymentIncarnation !== permit.deploymentIncarnation ||
            result.runtimeID !== current.runtimeID ||
            result.sessionID !== permit.sessionID ||
            result.bindingEpoch !== current.bindingEpoch ||
            result.rootID !== proof.rootID ||
            result.generation !== proof.generation ||
            result.outcome !== proof.outcome ||
            result.materialized !== proof.materialized
          )
            throw failure(
              "PROTOCOL_MISMATCH",
              "Execution release receipt does not match its proven resource generation",
            )
        },
        signal,
      )
    },
    async reserve(value, signal) {
      const proof = Gateway.Proof.parse(value)
      return invoke(
        proof,
        Gateway.SignedPermit,
        async (signal) =>
          client.orgGateway.reserve(
            { orgGatewayRequest: { proof, signature: await Gateway.signRequest(proof, options.key) } },
            { signal },
          ),
        async (result) => {
          target(proof, result.permit)
          if (
            result.permit.keyID !== connection.signingIdentity.keyID ||
            !(await Gateway.verifyPermit(result.permit, result.signature, connection.signingIdentity.publicKey))
          )
            throw failure("PROTOCOL_MISMATCH", "Organization resource capability signature is invalid")
        },
        signal,
      )
    },
    async inspect(value, signal) {
      const proof = Gateway.Proof.parse(value)
      return invoke(
        proof,
        Gateway.Receipt,
        async (signal) =>
          client.orgGateway.inspect(
            { orgGatewayRequest: { proof, signature: await Gateway.signRequest(proof, options.key) } },
            { signal },
          ),
        (result) => target(proof, result),
        signal,
      )
    },
    async invoke(value, input = {}) {
      const permit = await connectionPermit(value)
      const cancellation = AbortSignal.any([
        lifetime,
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(Math.max(0, Math.min(15_000, permit.permit.expiresAt - Date.now()))),
      ])
      const pending = (async () => {
        await acquire(cancellation)
        let retained = false
        try {
          cancellation.throwIfAborted()
          const bytes =
            input.body === undefined
              ? undefined
              : typeof input.body === "string"
                ? new TextEncoder().encode(input.body)
                : input.body instanceof Uint8Array
                  ? input.body
                  : new Uint8Array(input.body)
          if (bytes && bytes.byteLength > permit.permit.requestBytes)
            throw failure(
              "RESOURCE_UNAVAILABLE",
              "Organization connection request exceeds its byte allowance",
              "not_dispatched",
            )
          const response = await transport.fetch(
            new URL(`/runtime/v1/gateway/connections/${encodeURIComponent(permit.permit.resourceID)}`, options.origin),
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${Gateway.encode(permit)}`,
                "content-type": "application/json",
              },
              body: bytes ? Buffer.from(bytes) : undefined,
              signal: cancellation,
              credentials: "omit",
              redirect: "error",
            },
          )
          cancellation.throwIfAborted()
          const reader = response.body?.getReader()
          if (!reader) {
            release()
            return response
          }
          retained = true
          const done = Promise.withResolvers<void>()
          const body = { reader, done: done.promise }
          bodies.add(body)
          let settled = false
          const finish = async () => {
            if (settled) return
            settled = true
            bodies.delete(body)
            reader.releaseLock()
            release()
            done.resolve()
          }
          const abort = () => {
            void reader
              .cancel()
              .catch(() => {})
              .then(async () => {
                await finish()
              })
          }
          cancellation.addEventListener("abort", abort, { once: true })
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                cancellation.throwIfAborted()
                const item = await reader.read()
                cancellation.throwIfAborted()
                if (item.done) {
                  cancellation.removeEventListener("abort", abort)
                  await finish()
                  controller.close()
                  return
                }
                controller.enqueue(item.value)
              } catch (error) {
                cancellation.removeEventListener("abort", abort)
                await reader.cancel().catch(() => {})
                await finish()
                controller.error(error)
              }
            },
            async cancel() {
              cancellation.removeEventListener("abort", abort)
              await reader.cancel().catch(() => {})
              await finish()
            },
          })
          return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch (error) {
          if (!retained) release()
          cancellation.throwIfAborted()
          if (error instanceof OrganizationRuntimeError) throw error
          throw failure("SERVICE_UNAVAILABLE", "Organization business connection is unavailable")
        }
      })()
      active.add(pending)
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      )
      return pending
    },
    async invokeMcp(value, input, signal) {
      const permit = await connectionPermit(value)
      if (permit.permit.protocol !== "mcp-http" && permit.permit.protocol !== "mcp-sse")
        throw failure(
          "PROTOCOL_MISMATCH",
          "Organization connection capability is not an MCP resource",
          "not_dispatched",
        )
      const cancellation = AbortSignal.any([
        lifetime,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(Math.max(0, Math.min(15_000, permit.permit.expiresAt - Date.now()))),
      ])
      const pending = (async () => {
        await acquire(cancellation)
        try {
          cancellation.throwIfAborted()
          const operation = Gateway.McpRequest.parse(input)
          const requestBytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength
          if (requestBytes > permit.permit.requestBytes)
            throw failure(
              "RESOURCE_UNAVAILABLE",
              "Organization MCP request exceeds its byte allowance",
              "not_dispatched",
            )
          const response = await client.orgGateway.mcp(
            {
              resourceID: permit.permit.resourceID,
              orgGatewayMcpRequest: operation,
            },
            {
              signal: cancellation,
              headers: { authorization: `Bearer ${Gateway.encode(permit)}` },
            },
          )
          if (!response.data) {
            const error = OrganizationProtocol.Error.safeParse(response.error)
            if (error.success) throw new OrganizationRuntimeError(error.data)
            throw failure("SERVICE_UNAVAILABLE", "Organization MCP response is unavailable")
          }
          return Gateway.McpResult.parse(response.data)
        } catch (error) {
          cancellation.throwIfAborted()
          if (error instanceof OrganizationRuntimeError) throw error
          if (error instanceof SyntaxError || error instanceof z.ZodError)
            throw failure("PROTOCOL_MISMATCH", "Organization MCP response has an invalid format")
          throw error
        } finally {
          release()
        }
      })()
      active.add(pending)
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      )
      return pending
    },
  }
  return {
    resources,
    close() {
      stop.abort()
      for (const body of bodies) void body.reader.cancel().catch(() => {})
      return (closing ??= Promise.allSettled([...active, ...[...bodies].map((body) => body.done)]).then(() =>
        transport.close(),
      ))
    },
  }
}
