import { createHash } from "node:crypto"
import { isDeepStrictEqual as equal } from "node:util"
import { z } from "zod"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecutionOriginIndex } from "@ericsanchezok/synergy-harness/environment/execution-origin-index"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationProtocol,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationCloudRecord as Wire } from "./cloud-records"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const scopeID = Wire.scopeID
const Reference = z.strictObject({
  workspaceID: Identity.ID,
  scopeID: Identity.ID,
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  manifest: WorkspaceTree.Hash.nullable(),
  createdAt: z.number(),
})
type Reader = Record.HistoricalReader
function fail(message: string): never {
  throw new Error("Cloud resource history " + message)
}
function hasEntries(reader: Reader, prefix: string[]) {
  for (const _ of reader.entries(prefix)) return true
  return false
}

export namespace OrganizationCloudResourceHistory {
  export const ContentReference = Reference
  export function resource(reader: Reader, orgID: string, resourceID: string) {
    const resource = reader.read(Record.Resource, Keys.resource(orgID, resourceID))
    if (
      resource.orgID !== orgID ||
      resource.resourceID !== resourceID ||
      !["workspace-storage", "environment"].includes(resource.configuration.protocol) ||
      resource.credential.kind !== "none" ||
      resource.secretID
    )
      fail("requires its original infrastructure definition without native credentials")
    return resource
  }
  function locator(reader: Reader, kind: "workspaces" | "environments", id: string) {
    const value = reader.read(Wire.Locator, Wire.key(kind, id))
    const deployment = reader.read(OrganizationProtocol.Deployment, Keys.deployment())
    const definition = resource(reader, value.orgID, value.resourceID)
    const project = reader.read(Record.Project, Keys.project(value.projectID))
    if (
      value.id !== id ||
      value.orgID !== deployment.orgID ||
      project.orgID !== value.orgID ||
      project.projectID !== value.projectID ||
      definition.configuration.protocol !== (kind === "workspaces" ? "workspace-storage" : "environment") ||
      (definition.scope.kind === "project" && definition.scope.projectID !== value.projectID)
    )
      fail("has another canonical resource or project")
    return value
  }
  function workspace(reader: Reader, id: string) {
    const loc = locator(reader, "workspaces", id)
    const value = reader.read(WorkspaceCatalog.Info, StoragePath.workspace(id))
    if (
      value.id !== id ||
      value.scopeID !== scopeID(loc.orgID, loc.projectID) ||
      value.backend?.provider !== "objects" ||
      value.binding.state !== "bound" ||
      value.binding.path !== null ||
      value.binding.hostID !== "provider" ||
      value.activeMount ||
      value.lifecycle !== "active" ||
      value.recovery ||
      value.importedFrom ||
      value.sharedWritableWorkspaceIDs.length ||
      !equal(value.metadata.organization, { orgID: loc.orgID, projectID: loc.projectID, resourceID: loc.resourceID })
    )
      fail("requires its dormant original object Workspace")
    WorkspaceContent.Spec.parse(value.backend.spec)
    if (reader.read(z.string(), StoragePath.workspaceScope(value.scopeID, id)) !== id)
      fail("has another Workspace index")
    if (value.content?.revision) {
      const head = reader.read(Reference, StoragePath.workspaceContent(id, value.content.revision))
      if (
        head.workspaceID !== id ||
        head.scopeID !== value.scopeID ||
        head.generation !== value.binding.generation ||
        head.revision !== value.content.revision ||
        head.manifest !== value.content.manifest
      )
        fail("has another saved head")
    } else if (value.content?.manifest !== null) fail("has no canonical empty head")
    return value
  }
  function environment(reader: Reader, id: string) {
    const loc = locator(reader, "environments", id)
    const value = reader.read(Environment.Info, StoragePath.environment(id))
    if (
      value.id !== id ||
      value.scopeID !== scopeID(loc.orgID, loc.projectID) ||
      value.state !== "idle" ||
      value.allocation ||
      hasEntries(reader, StoragePath.environmentUses(id)) ||
      reader.read(z.string(), StoragePath.environmentScope(value.scopeID, id)) !== id
    )
      fail("requires its genuinely idle Environment without retained Uses")
    return value
  }
  export function accept(reader: Reader, accept: (key: string[]) => void) {
    EnvironmentExecutionOriginIndex.history(reader, accept)
    let workspaces = 0,
      environments = 0
    for (const { key, value } of reader.entries(["workspace"])) {
      const info = WorkspaceCatalog.Info.parse(value)
      if (!equal(key, StoragePath.workspace(info.id))) fail("has another Workspace key")
      workspace(reader, info.id)
      accept(key)
      workspaces++
    }
    for (const { key, value } of reader.entries(["workspace_scope"])) {
      const id = z.string().parse(value),
        info = workspace(reader, id)
      if (!equal(key, StoragePath.workspaceScope(info.scopeID, id))) fail("has another Workspace scope index")
      accept(key)
    }
    for (const { key, value } of reader.entries(["workspace_content"])) {
      const head = Reference.parse(value),
        info = workspace(reader, head.workspaceID)
      if (
        !equal(key, StoragePath.workspaceContent(info.id, head.revision)) ||
        head.scopeID !== info.scopeID ||
        head.generation !== info.binding.generation ||
        head.revision > (info.content?.revision ?? 0)
      )
        fail("has another retained Workspace head")
      accept(key)
    }
    for (const { key, value } of reader.entries(["environment"])) {
      const info = Environment.Info.parse(value)
      if (!equal(key, StoragePath.environment(info.id))) fail("has another Environment key")
      environment(reader, info.id)
      accept(key)
      environments++
    }
    for (const prefix of ["environment_scope", "environment_binding"])
      for (const { key, value } of reader.entries([prefix])) {
        const id = z.string().parse(value),
          info = environment(reader, id)
        if (key.length !== 3 || key[1] !== info.scopeID || (prefix === "environment_scope" && key[2] !== id))
          fail("has another Environment index")
        accept(key)
      }
    for (const { key, value } of reader.entries(["organization", "cloud"])) {
      const kind = key[2]
      if ((kind === "workspaces" || kind === "environments") && key.length === 4) {
        const loc = Wire.Locator.parse(value)
        if (!equal(loc, locator(reader, kind, key[3]!))) fail("has another locator")
        kind === "workspaces" ? workspace(reader, loc.id) : environment(reader, loc.id)
      } else if (kind === "project" && key.length === 8 && (key[3] === "workspaces" || key[3] === "environments")) {
        const loc = locator(reader, key[3], key[7]!)
        if (
          !equal(key, [...Wire.projectKey(key[3], loc.orgID, loc.projectID, loc.resourceID), loc.id]) ||
          !equal(value, { id: loc.id })
        )
          fail("has another cloud project index")
      } else if (kind === "creation" && key.length === 7 && (key[3] === "workspaces" || key[3] === "environments")) {
        const account = reader.read(Record.Account, Keys.account(key[5]!))
        const receipt = key[3] === "workspaces" ? Wire.Receipt.parse(value) : Wire.EnvironmentReceipt.parse(value)
        const id = "result" in receipt ? receipt.result.workspaceID : receipt.id
        const loc = locator(reader, key[3], id)
        const request = { projectID: loc.projectID, resourceID: loc.resourceID, requestID: key[6]!, name: loc.name }
        if (
          account.orgID !== loc.orgID ||
          key[4] !== loc.orgID ||
          account.accountID !== key[5] ||
          receipt.digest !== hash(request)
        )
          fail("has another original creation receipt")
        if ("result" in receipt) checkView(reader, workspace(reader, id), loc, receipt.result)
        else environment(reader, id)
      } else if (kind === "receipts" && (key.length === 5 || (key.length === 6 && key[4] === "file"))) {
        const loc = locator(reader, "workspaces", key[3]!),
          info = workspace(reader, loc.id)
        if (key.length === 5) {
          const receipt = Wire.Receipt.parse(value)
          Cloud.Hash.parse(receipt.digest)
          checkView(reader, info, loc, receipt.result)
        } else {
          const receipt = Wire.FileReceipt.parse(value),
            ref = receipt.reference,
            result = receipt.result
          const { revision: priorRevision, ...prior } = ref
          const { revision: nextRevision, ...next } = result.reference
          if (
            ref.workspaceID !== info.id ||
            ref.orgID !== loc.orgID ||
            ref.projectID !== loc.projectID ||
            ref.resourceID !== loc.resourceID ||
            ref.generation !== info.binding.generation ||
            priorRevision >= nextRevision ||
            nextRevision > info.revision ||
            !equal(prior, next) ||
            !["write", "mutate"].includes(result.result.action)
          )
            fail("has another completed file receipt")
          if (result.result.action === "write" || result.result.action === "mutate") {
            const checkpoint = result.result.checkpoint
            if (
              checkpoint.mount.workspaceID !== info.id ||
              checkpoint.mount.generation !== info.binding.generation ||
              !checkpoint.isolated
            )
              fail("has another file publication")
          }
        }
      } else fail("contains an unsupported cloud operation")
      accept(key)
    }
    return { workspaces, environments }
  }
  function checkView(reader: Reader, info: WorkspaceCatalog.Info, loc: Wire.Locator, value: Cloud.Workspace) {
    if (
      value.workspaceID !== info.id ||
      value.orgID !== loc.orgID ||
      value.projectID !== loc.projectID ||
      value.resourceID !== loc.resourceID ||
      value.name !== loc.name ||
      value.generation !== info.binding.generation ||
      value.revision > info.revision ||
      value.contentRevision > (info.content?.revision ?? 0) ||
      value.activeMount
    )
      fail("has another historical Workspace view")
    if (value.contentRevision) {
      const head = reader.read(Reference, StoragePath.workspaceContent(info.id, value.contentRevision))
      if (head.manifest !== value.manifest || head.generation !== value.generation || head.scopeID !== info.scopeID)
        fail("has another historical content version")
    } else if (value.manifest !== null) fail("has another empty historical head")
  }
}
