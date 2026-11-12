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
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "rejected", retryable: false })
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
  export async function run<T>(
    value: Handoff.MachinePlan,
    resources: Partial<Pick<MemberResourceClient, "handoffWorkspace">> | undefined,
    signal: AbortSignal,
    body: () => Promise<T>,
  ) {
    const plan = Handoff.MachinePlan.parse(value)
    if (!plan.workspacePlan || plan.workspacePlan.mapping.kind === "native") return body()
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
