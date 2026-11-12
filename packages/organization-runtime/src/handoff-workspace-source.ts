import { AsyncLocalStorage } from "node:async_hooks"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import {
  SessionTransferWorkspaces as Files,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { OrganizationSessionTransfer as Transfer } from "./session-transfer"
import { OrganizationRuntimeError } from "./error"
import type { MemberResourceClient } from "./resource-client"

export namespace OrganizationHandoffWorkspaceSource {
  interface Frame {
    plan: Handoff.MachinePlan
    snapshot: WorkspaceArchive.Subtree
    send: MemberResourceClient["handoffWorkspace"]
    signal: AbortSignal
    assert(): void
  }
  const frames = new AsyncLocalStorage<Frame>()
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "HANDOFF_BLOCKED", message, outcome: "rejected", retryable: false })
  }
  export function register() {
    Files.registerSourceProvider("organization", {
      source(binding) {
        const frame = frames.getStore()
        if (!frame) fail("Remote capture requires its actual source controller callback")
        const mapping = frame.plan.workspacePlan?.mapping
        if (
          !mapping ||
          (mapping.kind !== "organization-live" && mapping.kind !== "organization-native") ||
          binding.handoffID !== frame.plan.handoffID ||
          binding.sessionID !== frame.plan.sessionID ||
          binding.scopeID !== frame.plan.sourceBinding.projectID ||
          binding.sourceID !== frame.plan.sourceRuntimeID ||
          binding.targetID !== frame.plan.targetRuntimeID ||
          binding.fromEpoch !== frame.plan.fromEpoch ||
          binding.toEpoch !== frame.plan.toEpoch
        )
          fail("Remote source has another exact source epoch")
        return {
          assert: frame.assert,
          async capture(workspace, store, signal) {
            frame.assert()
            const spec = Cloud.FileLocator.parse(workspace.backend?.spec)
            if (
              workspace.id !== mapping.source.workspaceID ||
              workspace.binding.generation !== mapping.source.generation ||
              workspace.scopeID !== binding.scopeID ||
              workspace.content ||
              workspace.activeMount ||
              workspace.binding.path !== null ||
              spec.orgID !== frame.plan.orgID ||
              spec.deploymentIncarnation !== frame.plan.deploymentIncarnation ||
              spec.projectID !== binding.scopeID ||
              spec.resourceID !== mapping.resource.resourceID ||
              spec.workspaceID !== mapping.resource.workspaceID ||
              spec.generation !== mapping.resource.generation ||
              spec.path !== mapping.resource.path
            )
              fail("Remote capture differs from its original Locator and service selection")
            await WorkspaceArchive.copyManifest(
              {
                manifest: frame.snapshot.manifest,
                source: {
                  async get(hash, maximumBytes) {
                    frame.assert()
                    signal.throwIfAborted()
                    const result = await frame.send(
                      frame.plan,
                      { action: "source-object", hash, maximumBytes: Math.min(maximumBytes, Cloud.chunkBytes) },
                      frame.signal,
                    )
                    frame.assert()
                    if (result.action !== "source-object" || result.hash !== hash)
                      fail("Remote capture returned another graph object")
                    return Uint8Array.from(Buffer.from(result.data, "base64"))
                  },
                },
              },
              store,
              signal,
            )
            frame.assert()
            return frame.snapshot.files
          },
        }
      },
    })
  }
  export async function run<T>(
    plan: Handoff.MachinePlan,
    resources: MemberResourceClient | undefined,
    signal: AbortSignal,
    body: () => Promise<T>,
  ) {
    if (
      plan.workspacePlan?.mapping.kind !== "organization-live" &&
      plan.workspacePlan?.mapping.kind !== "organization-native"
    )
      return body()
    if (!resources) fail("Remote source requires its original machine resource client")
    const send = resources.handoffWorkspace.bind(resources)
    const owner = WorkspaceContent.captureOwner(signal)
    let open = true
    const assert = () => {
      owner()
      if (!open) fail("Remote source callback has ended")
    }
    try {
      const result = await send(plan, { action: "source" }, signal)
      assert()
      if (result.action !== "source") fail("Remote source returned another operation")
      const snapshot = WorkspaceArchive.Subtree.parse(result.snapshot)
      const frame: Frame = {
        plan,
        snapshot,
        send,
        signal,
        assert() {
          assert()
          if (frames.getStore() !== frame) fail("Remote source belongs to another capture callback")
        },
      }
      return await frames.run(frame, async () => {
        const resultValue = await body()
        frame.assert()
        await Transfer.retainWorkspaceSource(
          Epochs.Binding.parse({
            sessionID: plan.sessionID,
            scopeID: plan.sourceBinding.projectID,
            handoffID: plan.handoffID,
            sourceID: plan.sourceRuntimeID,
            targetID: plan.targetRuntimeID,
            fromEpoch: plan.fromEpoch,
            toEpoch: plan.toEpoch,
          }),
          snapshot,
          signal,
        )
        frame.assert()
        return resultValue
      })
    } finally {
      open = false
    }
  }
}
