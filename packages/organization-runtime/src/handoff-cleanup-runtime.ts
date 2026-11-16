import { z } from "zod"
import path from "node:path"
import { OrganizationHandoffRecovery as Recovery } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { readStorageConfiguration } from "@ericsanchezok/synergy-harness/storage/config"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { registerWorkspaceMigrations } from "@ericsanchezok/synergy-harness/workspace/migration"
import {
  SessionTransferCore,
  SessionTransferEvidence,
  SessionTransferSnapshots,
  SessionTransferWorkspaces,
  SessionTransferEnvironments,
} from "@ericsanchezok/synergy-harness/session/transfer"
import {
  createWorkspaceCleanupHost,
  registerNativeWorkspaceCleanup,
} from "@ericsanchezok/synergy-local-runtime/workspace/cleanup"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { RuntimeIdentity, NativeHomeReaderContract, readRuntimeHome, runtimeIdentityDigest } from "./home"
import { MemberLaunchRequest } from "./launch"
import { readRuntimeRegistration } from "./registration"
import { MemberHomeError } from "./record"
import { memberEnvironment } from "./environment"
import { registerSessionSchema } from "./session-schema"
import { registerOrganizationTransferOwner } from "./session-transfer"
import { OrganizationHostedPublication } from "./backup/publication"
import { OrganizationHandoffTarget } from "./handoff-target"
import { OrganizationHandoffCleanup, registerHandoffCleanup } from "./handoff-recovery"

export const HandoffCleanupRequest = z.strictObject({
  version: z.literal(1),
  identity: RuntimeIdentity,
  deploymentIncarnation: z.string().min(1).max(128),
  ca: MemberLaunchRequest.shape.ca,
})
export type HandoffCleanupOpen = z.infer<typeof HandoffCleanupRequest> & { home: string; readonly: boolean }
export type HandoffCleanupRuntime = Awaited<ReturnType<typeof openHandoffCleanup>>

export async function openHandoffCleanup(
  input: HandoffCleanupOpen,
  composition: { workspaceCoordinator?: WorkspaceCoordinator } = {},
) {
  const request = HandoffCleanupRequest.parse({
    version: input.version,
    identity: input.identity,
    deploymentIncarnation: input.deploymentIncarnation,
    ca: input.ca,
  })
  const readonly = z.boolean().parse(input.readonly),
    home = input.home,
    coordinator = composition.workspaceCoordinator ?? new WorkspaceCoordinator(),
    environment = { ...process.env },
    member = await readRuntimeHome(home, request.identity),
    registration = await readRuntimeRegistration(member.home, member.identity)
  if (
    !registration ||
    registration.state === "pending" ||
    registration.deploymentIncarnation !== request.deploymentIncarnation
  )
    throw new MemberHomeError("Cleanup requires this Home's retained enrolled deployment")
  const configuration = await readStorageConfiguration(member.root),
    selectedEnvironment: Record<string, string | undefined> = memberEnvironment(member, environment)
  if (configuration.backend === "postgres")
    selectedEnvironment[configuration.connectionEnv] = environment[configuration.connectionEnv]
  const host = await createWorkspaceCleanupHost({
    home: member.home,
    root: member.root,
    env: selectedEnvironment,
  })
  const context = RuntimeContext.create(host, "oneshot")
  return context.run(async () => {
    let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined,
      store: Awaited<ReturnType<typeof StorageBootstrap.openExisting>>["store"] | undefined,
      stop: (() => Promise<void>) | undefined,
      closing: Promise<void> | undefined
    const active = new Set<Promise<unknown>>()
    let accepting = true
    const close = () =>
      (closing ??= context.run(async () => {
        accepting = false
        const errors: unknown[] = []
        for (const cleanup of [
          () => stop?.(),
          async () => {
            await Promise.allSettled(active)
          },
          async () => {
            if (!store) return
            Storage.closeArtifactAdmission()
            await Storage.drainArtifactPreparations()
          },
          () => store?.close(),
          () => writer?.release(),
        ]) {
          try {
            await cleanup()
          } catch (error) {
            errors.push(error)
          }
        }
        context.dispose()
        if (errors.length) throw new AggregateError(errors, "Original Handoff cleanup did not close")
      }))
    function run<T>(body: () => Promise<T>) {
      if (!accepting) throw new MemberHomeError("Original Handoff cleanup is closed")
      const pending = context.run(body)
      active.add(pending)
      void pending.finally(() => active.delete(pending)).catch(() => {})
      return pending
    }
    try {
      HomeOwnership.select(
        member.restoration ?? {
          owner: "organization-runtime",
          identity: runtimeIdentityDigest(member.identity),
          readerContract: NativeHomeReaderContract,
        },
      )
      await HomeOwnership.assert({ required: true })
      HomeRestoration.register()
      OrganizationHostedPublication.register()
      RuntimeMaintenance.registerProtection()
      registerSessionSchema({ orgID: member.identity.orgID })
      registerWorkspaceMigrations()
      SessionTransferCore.register()
      SessionTransferEvidence.register()
      SessionTransferSnapshots.register()
      SessionTransferWorkspaces.register()
      SessionTransferEnvironments.register()
      registerOrganizationTransferOwner()
      registerNativeWorkspaceCleanup(coordinator)
      writer = await ServerProcessLock.acquire()
      const attached = readonly
        ? await StorageBootstrap.inspect(member.root)
        : await StorageBootstrap.openExisting(member.root)
      if (!attached) throw new MemberHomeError("Cleanup requires an existing active storage manifest")
      store = attached.store
      context.storage = { store, artifactDirectory: path.join(member.root, "data") }
      await HomeRestoration.assertOrdinaryStartup()
      const target = OrganizationHandoffTarget.create({ identity: member.identity, runtimeID: registration.runtimeID })
      stop = registerHandoffCleanup({
        identity: member.identity,
        runtimeID: registration.runtimeID,
        ca: request.ca,
        target: target.recover,
      })
      MigrationRegistry.lock()
      ConfigExtensions.lock()
      RuntimeContext.sealComposition()
      return Object.freeze({
        list: (query: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) =>
          run(() => OrganizationHandoffCleanup.discover(query)),
        inspect: (descriptor: z.infer<typeof Recovery.Descriptor>, query: { signal?: AbortSignal } = {}) =>
          run(() => OrganizationHandoffCleanup.inspect(descriptor, query)),
        sourceReceipt: (handoffID: string, query: { signal?: AbortSignal } = {}) =>
          run(() => OrganizationHandoffCleanup.sourceReceipt(handoffID, query)),
        retire(descriptor: z.infer<typeof Recovery.Descriptor>, query: { signal?: AbortSignal } = {}) {
          if (readonly) throw new MemberHomeError("Read-only cleanup cannot retire an original target")
          return run(() => OrganizationHandoffCleanup.retire(descriptor, query))
        },
        close,
        [Symbol.asyncDispose]: close,
      })
    } catch (error) {
      await close().catch(() => {})
      throw error
    }
  })
}
