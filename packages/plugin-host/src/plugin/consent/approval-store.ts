import { manifestHasTrustedUI, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import {
  computePermissionsHash,
  permissionsHashPayload,
  type PluginGrantContract,
} from "@ericsanchezok/synergy-plugin/integrity"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { PluginSource, TrustTier } from "../trust.js"
import { comparePluginAccess } from "./diff.js"

export interface PluginApprovalRecord {
  schemaVersion: 2
  pluginId: string
  source: PluginSource
  signer?: string
  grant: PluginGrantContract
  grantHash: string
  approvedAt: number
  approvedBy: "user" | "policy" | "builtin"
  trustTier: TrustTier
  approvedCapabilities: string[]
}

async function readAll(): Promise<PluginApprovalRecord[]> {
  const keys = await Storage.list(["plugin-approvals", "records"])
  return (await Storage.readMany<PluginApprovalRecord>(keys))
    .filter((record): record is PluginApprovalRecord => record !== undefined)
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
}

export const readApprovals = readAll

export async function writeApprovals(records: PluginApprovalRecord[]) {
  await Storage.transaction(async (tx) => {
    await tx.removeTree(["plugin-approvals", "records"])
    for (const record of records) await tx.write(["plugin-approvals", "records", record.pluginId], record)
  })
}

export function createApprovalRecord(input: {
  pluginId: string
  source: PluginSource
  manifest: PluginManifestType
  capabilities?: string[]
  signer?: string
  approvedBy?: PluginApprovalRecord["approvedBy"]
}): PluginApprovalRecord {
  const capabilities = input.capabilities ?? input.manifest.capabilities.map((item) => item.id)
  return {
    schemaVersion: 2,
    pluginId: input.pluginId,
    source: input.source,
    ...(input.signer ? { signer: input.signer } : {}),
    grant: permissionsHashPayload(input.manifest, capabilities),
    grantHash: computePermissionsHash(input.manifest, capabilities),
    approvedAt: Date.now(),
    approvedBy: input.approvedBy ?? "user",
    trustTier: manifestHasTrustedUI(input.manifest) ? "trusted-import" : "declarative",
    approvedCapabilities: capabilities,
  }
}

export async function getApproval(pluginId: string, manifest?: PluginManifestType) {
  const [record] = await Storage.readMany<PluginApprovalRecord>([["plugin-approvals", "records", pluginId]])
  return record && (!manifest || verifyApproval(record, manifest)) ? record : undefined
}

export async function saveApproval(record: PluginApprovalRecord) {
  await Storage.write(["plugin-approvals", "records", record.pluginId], record)
}

export async function removeApproval(pluginId: string) {
  await Storage.remove(["plugin-approvals", "records", pluginId])
}

export function verifyApproval(
  record: PluginApprovalRecord,
  manifest: PluginManifestType,
  capabilities = manifest.capabilities.map((item) => item.id),
  identity: { source?: PluginSource; signer?: string } = {},
) {
  if ("source" in identity && record.source !== identity.source) return false
  if ("signer" in identity && record.signer !== identity.signer) return false
  const candidate = permissionsHashPayload(manifest, capabilities)
  return comparePluginAccess(record.grant, candidate) !== "broadened"
}
