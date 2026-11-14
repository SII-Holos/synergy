import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationLocalProjectProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceBinding, WorkspaceCatalog, WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import type { Session } from "@ericsanchezok/synergy-harness/session"
import type { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { OrganizationRuntimeError } from "./error"
import type { RuntimeIdentity } from "./home"

export namespace OrganizationLocalProjects {
  const configuration = RuntimeContext.state(() => ({ identity: undefined as RuntimeIdentity | undefined }))
  const receipt = (projectID: string, requestID: string) => [
    "organization_local_project_binding",
    projectID,
    "operations",
    requestID,
  ]
  const Receipt = z.strictObject({ version: z.literal(1), requestHash: z.string(), summary: Protocol.Summary })
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const revision = (local: Scope.Local | null) => digest(Scope.Local.nullable().parse(local))
  const native: EnvironmentProviders.Default = { provider: "native", spec: {}, reuse: "scope" }
  function fail(code: "PERMISSION_DENIED" | "REVISION_CONFLICT" | "RESOURCE_UNAVAILABLE", message: string): never {
    throw new OrganizationRuntimeError({ code, message, outcome: "not_dispatched", retryable: false })
  }
  function member() {
    const identity = configuration().identity
    if (!identity || !("accountID" in identity))
      fail("PERMISSION_DENIED", "A local project binding requires this machine's member Runtime")
    return identity
  }

  export function register(identity: RuntimeIdentity) {
    RuntimeContext.assertCompositionOpen("Organization local projects")
    if (configuration().identity) throw new Error("Organization local projects are already registered")
    configuration().identity = identity
  }

  export async function get(projectID: string): Promise<Protocol.Summary> {
    member()
    const scope = await Scope.fromID(projectID)
    if (!scope || scope.type === "home")
      return Protocol.Summary.parse({ projectID, revision: revision(null), binding: null })
    if (!scope.local) return Protocol.Summary.parse({ projectID, revision: revision(null), binding: null })
    const workspace = await WorkspaceCatalog.findByLocation({
      scopeID: projectID,
      hostID: await WorkspaceLocation.source().hostID(),
      path: scope.local.directory,
    })
    if (!workspace) fail("RESOURCE_UNAVAILABLE", "The project's native Workspace binding is unavailable")
    return Protocol.Summary.parse({
      projectID,
      revision: revision(scope.local),
      binding: {
        label: path.basename(scope.local.directory) || "Project",
        workspaceID: workspace.id,
        generation: workspace.binding.generation,
      },
    })
  }

  export async function bind(projectID: string, value: Protocol.Bind) {
    member()
    const input = Protocol.Bind.parse(value)
    const requestHash = digest({ projectID, ...input })
    const key = receipt(projectID, input.requestID)
    const [retained] = await Storage.readMany([key])
    if (retained !== undefined) {
      const previous = Receipt.parse(retained)
      if (previous.requestHash !== requestHash)
        fail("REVISION_CONFLICT", "The local binding request changed during retry")
      return previous.summary
    }
    if (!path.isAbsolute(input.directory)) fail("RESOURCE_UNAVAILABLE", "Choose an absolute native project directory")
    const source = WorkspaceLocation.source()
    const location = await source.identify(input.directory)
    const selected = await Scope.fromDirectory(location.path, { persist: false })
    const local = Scope.Local.parse({
      directory: location.path,
      worktree: location.path,
      vcs: selected.scope.local?.vcs,
      sandboxes: [],
    })
    const hostID = await source.hostID()
    return WorkspaceAccess.exclusive([location.path], async () => {
      const checked = await source.identify(location.path)
      if (checked.path !== location.path || checked.physicalID !== location.physicalID)
        fail("REVISION_CONFLICT", "The chosen directory changed during binding")
      return Storage.transaction(async () => {
        const [stored] = await Storage.readMany([key])
        if (stored !== undefined) {
          const previous = Receipt.parse(stored)
          if (previous.requestHash !== requestHash)
            fail("REVISION_CONFLICT", "The local binding request changed during retry")
          return previous.summary
        }
        const previous = await Scope.fromID(projectID)
        if (previous?.type === "home" || (previous?.type === "project" && previous.time.archived))
          fail("PERMISSION_DENIED", "The project Scope is unavailable")
        if (revision(previous?.local ?? null) !== input.expectedRevision)
          fail("REVISION_CONFLICT", "The project's local directory binding changed")
        const now = Date.now()
        const scope = await Scope.registerProject({
          type: "project",
          id: projectID,
          local: null,
          time: { created: now, updated: now },
        })
        const workspace = await WorkspaceCatalog.register({ scopeID: projectID, type: "main", hostID, ...location })
        await Scope.bindLocal({ scopeID: projectID, expectedLocal: scope.local, local })
        await WorkspaceCatalog.publishUpdated(workspace)
        const summary = Protocol.Summary.parse({
          projectID,
          revision: revision(local),
          binding: {
            label: path.basename(location.path) || "Project",
            workspaceID: workspace.id,
            generation: workspace.binding.generation,
          },
        })
        await Storage.write(key, Receipt.parse({ version: 1, requestHash, summary }))
        return summary
      })
    })
  }

  export interface Creation {
    localRevision: string
    workspace: Session.Info["workspace"]
    workspaceID: string | null
    workspaceRevision?: number
    environmentID?: null
    environmentSelection?: EnvironmentProviders.Default
  }

  export async function prepareCreation(projectID: string): Promise<Creation> {
    const identity = configuration().identity
    if (!identity || !("accountID" in identity))
      return { localRevision: revision(null), workspace: null, workspaceID: null, environmentID: null }
    const scope = await Scope.fromID(projectID)
    if (!scope?.local)
      return { localRevision: revision(null), workspace: null, workspaceID: null, environmentSelection: native }
    const workspace = await WorkspaceBinding.describeDefault(scope)
    if (!workspace?.id) fail("RESOURCE_UNAVAILABLE", "The project's native Workspace is unavailable")
    await WorkspaceBinding.validate(workspace.id, projectID, workspace.generation)
    const catalog = await WorkspaceCatalog.get(workspace.id, projectID)
    return {
      localRevision: revision(scope.local),
      workspace,
      workspaceID: workspace.id,
      workspaceRevision: catalog.revision,
      environmentSelection: native,
    }
  }

  export async function assertCreation(scope: Scope, prepared: Creation) {
    const identity = configuration().identity
    if (!identity || !("accountID" in identity)) return
    if (revision(scope.local) !== prepared.localRevision)
      fail("REVISION_CONFLICT", "The project's local directory binding changed before Session creation")
    if (
      prepared.workspaceID &&
      (await WorkspaceCatalog.get(prepared.workspaceID, scope.id)).revision !== prepared.workspaceRevision
    )
      fail("REVISION_CONFLICT", "The native Workspace changed before Session creation")
  }
}
