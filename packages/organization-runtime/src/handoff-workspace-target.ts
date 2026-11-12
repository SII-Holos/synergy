import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import {
  SessionTransferWorkspaces as Files,
  SessionTransferStaging as Staging,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationSessionTransfer as Transfer } from "./session-transfer"
import { OrganizationRuntimeError } from "./error"
import type { MemberResourceClient } from "./resource-client"
import { NativeWorkspaceAdoption } from "@ericsanchezok/synergy-local-runtime/workspace/native-adoption"
import { OrganizationLocalProjects } from "./local-project"
import { OrganizationHandoffObjects } from "./handoff-objects"

export namespace OrganizationHandoffWorkspaceTarget {
  const provider = "organization"
  interface Frame {
    plan: Handoff.MachinePlan
    receipt?: WorkspaceMove.Receipt
    snapshot?: WorkspaceArchive.Subtree
    assert(): void
    validate(): Promise<void>
  }
  const frames = new AsyncLocalStorage<Frame>()
  function binding(plan: Handoff.MachinePlan) {
    return {
      sessionID: plan.sessionID,
      scopeID: plan.sourceBinding.projectID,
      handoffID: plan.handoffID,
      sourceID: plan.sourceRuntimeID,
      targetID: plan.targetRuntimeID,
      fromEpoch: plan.fromEpoch,
      toEpoch: plan.toEpoch,
    }
  }
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "rejected", retryable: false })
  }
  async function owned<T>(body: () => Promise<T>) {
    try {
      return await body()
    } catch (error) {
      if (error instanceof WorkspaceMove.Rejected)
        throw new OrganizationRuntimeError({
          code: "REVISION_CONFLICT",
          message: error.data.message,
          outcome: "rejected",
          retryable: false,
        })
      throw error
    }
  }
  function current() {
    const frame = frames.getStore()
    if (!frame) fail("Organization Workspace preparation requires its actual target controller")
    frame.assert()
    return frame
  }
  function locator(catalog: WorkspaceCatalog.Info) {
    const frame = current()
    const spec = Cloud.FileLocator.parse(catalog.backend?.spec)
    const mapping = frame.plan.workspacePlan?.mapping
    if (
      !mapping ||
      mapping.kind === "native" ||
      catalog.backend?.provider !== provider ||
      spec.orgID !== frame.plan.orgID ||
      spec.deploymentIncarnation !== frame.plan.deploymentIncarnation ||
      spec.projectID !== frame.plan.sourceBinding.projectID ||
      spec.mappingRevision !== frame.plan.mappingPlanRevision ||
      (mapping.kind === "organization-object"
        ? !frame.receipt ||
          spec.version !== 1 ||
          spec.resourceID !== mapping.target.resourceID ||
          spec.workspaceID !== mapping.target.workspaceID ||
          spec.generation !== mapping.target.generation ||
          spec.path !== mapping.target.path ||
          spec.moveID !== mapping.moveID ||
          spec.workspaceMoveReceiptHash !== WorkspaceMove.receiptHash(frame.receipt)
        : !frame.snapshot ||
          spec.version !== 2 ||
          spec.resourceID !== mapping.resource.resourceID ||
          spec.workspaceID !== mapping.resource.workspaceID ||
          spec.generation !== mapping.resource.generation ||
          spec.path !== mapping.resource.path ||
          spec.handoffID !== frame.plan.handoffID ||
          spec.workspaceSourceHash !== WorkspaceArchive.subtreeHash(frame.snapshot))
    )
      fail("Remote Locator changed its complete consented Workspace receipt")
  }
  export function register() {
    Files.registerTargetProvider(provider, {
      async prepare({ handoffID, captured, createdAt }) {
        const frame = current()
        const plan = frame.plan
        const mapping = plan.workspacePlan?.mapping
        if (
          !mapping ||
          mapping.kind === "native" ||
          handoffID !== plan.handoffID ||
          captured.workspaceID !== mapping.source.workspaceID ||
          captured.generation !== mapping.source.generation ||
          captured.scopeID !== plan.sourceBinding.projectID ||
          WorkspaceTree.hash(new TextEncoder().encode(JSON.stringify(captured.files))) !==
            (frame.receipt?.source.manifest ?? frame.snapshot?.manifest)
        )
          fail("Remote Workspace receipt differs from the verified captured graph")
        const resource = mapping.kind === "organization-object" ? mapping.target : mapping.resource
        const spec = Cloud.FileLocator.parse({
          orgID: plan.orgID,
          deploymentIncarnation: plan.deploymentIncarnation,
          projectID: captured.scopeID,
          resourceID: resource.resourceID,
          workspaceID: resource.workspaceID,
          generation: resource.generation,
          path: resource.path,
          mappingRevision: plan.mappingPlanRevision,
          ...(mapping.kind === "organization-object" && frame.receipt
            ? {
                version: 1,
                moveID: mapping.moveID,
                workspaceMoveReceiptHash: WorkspaceMove.receiptHash(frame.receipt),
              }
            : frame.snapshot
              ? {
                  version: 2,
                  handoffID: plan.handoffID,
                  workspaceSourceHash: WorkspaceArchive.subtreeHash(frame.snapshot),
                }
              : {}),
        })
        return WorkspaceCatalog.Info.parse({
          id:
            "wsp_" +
            createHash("sha256")
              .update(JSON.stringify([handoffID, captured.scopeID, captured.workspaceID]))
              .digest("hex"),
          scopeID: captured.scopeID,
          type: "directory",
          revision: 1,
          binding: { state: "bound", hostID: "organization:" + plan.orgID, path: null, generation: 1 },
          backend: { provider, spec },
          metadata: {},
          sharedWritableWorkspaceIDs: [],
          lifecycle: "active",
          createdAt: frame.receipt?.publishedAt ?? createdAt,
          updatedAt: frame.receipt?.publishedAt ?? createdAt,
        })
      },
      async validate(catalog) {
        locator(catalog)
        await current().validate()
        locator(catalog)
      },
      async withPublication(values, _signal, body) {
        for (const catalog of values) locator(catalog)
        await current().validate()
        const result = await body()
        for (const catalog of values) locator(catalog)
        return result
      },
      assertPublication: locator,
    })
  }
  function nativeRequest(plan: Handoff.MachinePlan) {
    const mapping = plan.workspacePlan?.mapping,
      actor = plan.workspacePlan?.targetActor,
      frozen = plan.frozen?.proof
    if (
      mapping?.kind !== "organization-native" ||
      !actor ||
      frozen?.purpose !== "source-frozen" ||
      !frozen.workspaceSourceHash
    )
      fail("Native adoption requires its original complete signed source and target consent")
    return WorkspaceMove.NativeRequest.parse({
      kind: "native-adoption",
      id: mapping.moveID,
      source: { ...mapping.source, scopeID: plan.sourceBinding.projectID },
      target: {
        workspaceID: mapping.target.workspaceID,
        generation: mapping.target.generation,
        scopeID: plan.sourceBinding.projectID,
        path: "",
        expectedRevision: mapping.target.expectedRevision,
      },
      mappingRevision: plan.mappingPlanRevision,
      sourceSnapshotHash: frozen.workspaceSourceHash,
      actor,
    })
  }
  async function native(
    value: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
    requireSource = true,
  ) {
    const plan = Handoff.MachinePlan.parse(value),
      mapping = plan.workspacePlan?.mapping,
      actor = plan.workspacePlan?.targetActor
    if (mapping?.kind !== "organization-native" || !actor || !resources?.handoffWorkspace)
      fail("Existing native adoption requires its original complete target consent")
    const owner = WorkspaceContent.captureOwner(signal),
      send = resources.handoffWorkspace.bind(resources)
    let snapshot: WorkspaceArchive.Subtree | undefined
    for await (const member of Staging.members({
      handoffID: plan.handoffID,
      rootSessionID: plan.sessionID,
      scopeID: plan.sourceBinding.projectID,
      signal,
    })) {
      if (member.session.id !== plan.sessionID) continue
      const context = await Staging.context({
        ownerID: Transfer.id,
        session: member.session,
        rootSessionID: plan.sessionID,
        handoffID: plan.handoffID,
        mapping: {},
        signal,
      })
      if (await Transfer.stagedWorkspaceMove(context))
        fail("Native adoption cannot borrow an object destination receipt")
      snapshot = (await Transfer.stagedWorkspaceSource(context)) ?? undefined
      break
    }
    const frozen = plan.frozen?.proof
    if (
      !snapshot ||
      frozen?.purpose !== "source-frozen" ||
      frozen.workspaceSourceHash !== WorkspaceArchive.subtreeHash(snapshot)
    )
      fail("Native adoption has no complete final service source")
    const original = snapshot
    const request = nativeRequest(plan)
    const local = async () => {
      owner()
      const selected = await OrganizationLocalProjects.get(plan.sourceBinding.projectID)
      const catalog = await WorkspaceCatalog.get(mapping.target.workspaceID, plan.sourceBinding.projectID)
      owner()
      if (
        selected.revision !== mapping.target.projectRevision ||
        selected.binding?.workspaceID !== mapping.target.workspaceID ||
        selected.binding.generation !== mapping.target.generation ||
        catalog.revision !== mapping.target.expectedRevision ||
        catalog.binding.generation !== mapping.target.generation ||
        catalog.backend?.provider !== "directory" ||
        !catalog.binding.path ||
        catalog.activeMount ||
        catalog.lifecycle !== "active"
      )
        fail("Native adoption target changed its consented project directory")
    }
    const recheck = async () => {
      await local()
      const result = await send(plan, { action: "source-validate" }, signal)
      owner()
      if (
        result.action !== "source-validate" ||
        JSON.stringify(WorkspaceArchive.Subtree.parse(result.snapshot)) !== JSON.stringify(original)
      )
        fail("Native adoption source changed its complete final snapshot")
    }
    if (requireSource) await recheck()
    const objects = await OrganizationHandoffObjects.open(
      { orgID: plan.orgID, deploymentIncarnation: plan.deploymentIncarnation, role: "target", binding: binding(plan) },
      signal,
    )
    owner()
    return { plan, request, snapshot: original, store: objects.store, assert: owner, recheck, commit: local, signal }
  }
  export async function preview(
    plan: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
  ) {
    const context = await native(plan, resources, signal)
    const frozen = plan.frozen!.proof
    const fileClosureHash = frozen.purpose === "source-frozen" ? frozen.fileClosureHash : null
    if (!fileClosureHash) fail("Native preview requires the full final file closure")
    return owned(() =>
      Files.withTargetCaptured(
        { binding: binding(plan), expectedReceiptHash: fileClosureHash, ...context.request.source, signal },
        (capture) =>
          WorkspaceMove.previewNative(context.request, {
            source: {
              snapshot: context.snapshot,
              store: capture.store,
              assert() {
                capture.assert()
                context.assert()
              },
              recheck: context.recheck,
            },
            store: context.store,
            signal,
          }),
      ),
    )
  }
  export async function difference(
    plan: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
  ) {
    const request = nativeRequest(Handoff.MachinePlan.parse(plan)),
      assert = WorkspaceContent.captureOwner(signal)
    if (!plan.expectedRevision) fail("Native difference paging requires the exact preview hash")
    const result = await owned(() =>
      WorkspaceMove.nativeDifference(request, {
        expectedRevision: plan.expectedRevision!,
        cursor: plan.cursor,
        limit: 64,
      }),
    )
    assert()
    return result
  }
  export async function status(
    plan: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
  ) {
    const request = nativeRequest(Handoff.MachinePlan.parse(plan)),
      assert = WorkspaceContent.captureOwner(signal)
    const status = await WorkspaceMove.inspect(request)
    assert()
    return status
  }
  export async function release(
    plan: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
    outcome: "activated" | "cancelled" | "retired",
  ) {
    const request = nativeRequest(Handoff.MachinePlan.parse(plan)),
      assert = WorkspaceContent.captureOwner(signal)
    if (await WorkspaceMove.inspect(request)) await WorkspaceMove.release(request, outcome)
    assert()
  }
  export async function run<T>(
    value: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
    body: () => Promise<T>,
  ) {
    const plan = Handoff.MachinePlan.parse(value)
    if (!plan.workspacePlan || plan.workspacePlan.mapping.kind === "native") return body()
    if (plan.workspacePlan.mapping.kind === "organization-native") {
      const context = await native(plan, resources, signal)
      if (!plan.workspacePlan.differenceConsent) fail("Native preparation requires the second exact difference consent")
      return owned(() =>
        NativeWorkspaceAdoption.run({ ...context, consent: plan.workspacePlan!.differenceConsent! }, body),
      )
    }
    if (!resources?.handoffWorkspace) fail("Remote Workspace target requires its original machine resource client")
    const send = resources.handoffWorkspace.bind(resources)
    const owner = WorkspaceContent.captureOwner(signal)
    let open = true
    const assert = () => {
      owner()
      if (!open) fail("Remote Workspace target callback has ended")
    }
    try {
      let receipt: WorkspaceMove.Receipt | null = null
      let snapshot: WorkspaceArchive.Subtree | null = null
      for await (const member of Staging.members({
        handoffID: plan.handoffID,
        rootSessionID: plan.sessionID,
        scopeID: plan.sourceBinding.projectID,
        signal,
      })) {
        if (member.session.id !== plan.sessionID) continue
        const context = await Staging.context({
          ownerID: Transfer.id,
          session: member.session,
          rootSessionID: plan.sessionID,
          handoffID: plan.handoffID,
          mapping: {},
          signal,
        })
        receipt = await Transfer.stagedWorkspaceMove(context)
        snapshot = await Transfer.stagedWorkspaceSource(context)
        break
      }
      assert()
      const frozen = plan.frozen?.proof
      if (plan.workspacePlan.mapping.kind === "organization-live") {
        if (
          receipt ||
          !snapshot ||
          frozen?.purpose !== "source-frozen" ||
          frozen.workspaceSourceHash !== WorkspaceArchive.subtreeHash(snapshot)
        )
          fail("Remote Workspace target has no complete frozen service snapshot")
        const original = snapshot
        const validate = async () => {
          assert()
          const result = await send(plan, { action: "source-validate" }, signal)
          assert()
          if (
            result.action !== "source-validate" ||
            JSON.stringify(WorkspaceArchive.Subtree.parse(result.snapshot)) !== JSON.stringify(original)
          )
            fail("Remote Workspace service no longer verifies its original snapshot")
        }
        await validate()
        return await frames.run({ plan, snapshot: original, assert, validate }, () =>
          Files.withTargetProvider(provider, body),
        )
      }
      if (
        !receipt ||
        frozen?.purpose !== "source-frozen" ||
        frozen.workspaceMoveReceiptHash !== WorkspaceMove.receiptHash(receipt)
      )
        fail("Remote Workspace target has no complete frozen CAS receipt")
      const original = receipt
      const validate = async () => {
        assert()
        const result = await send(plan, { action: "validate" }, signal)
        assert()
        if (
          result.action !== "validate" ||
          JSON.stringify(WorkspaceMove.Receipt.parse(result.receipt)) !== JSON.stringify(original)
        )
          fail("Remote Workspace service no longer verifies the original receipt")
      }
      await validate()
      return await frames.run({ plan, receipt: original, assert, validate }, () =>
        Files.withTargetProvider(provider, body),
      )
    } finally {
      open = false
    }
  }
}
