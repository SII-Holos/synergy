import path from "path"
import { manifestHasTrustedUI, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import {
  computePermissionsHash,
  permissionsHashPayload,
  type PluginGrantContract,
} from "@ericsanchezok/synergy-plugin/integrity"
import { Global } from "../../global/index.js"
import { Storage } from "../../storage/storage.js"
import { Lock } from "../../util/lock.js"
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

function approvalPath() {
  return path.join(Global.Path.data, "plugin-approvals.json")
}

async function readAll(): Promise<PluginApprovalRecord[]> {
  try {
    const value = JSON.parse(await Bun.file(approvalPath()).text())
    return Array.isArray(value)
      ? value.filter(
          (record): record is PluginApprovalRecord =>
            record?.schemaVersion === 2 &&
            typeof record.pluginId === "string" &&
            typeof record.grantHash === "string" &&
            record.grant &&
            typeof record.grant === "object",
        )
      : []
  } catch {
    return []
  }
}

// Lock is not reentrant: writeAll must stay lock-free because saveApproval,
// removeApproval, and writeApprovals already hold Lock.write across their
// read-modify-write, which serializes concurrent approval mutations in-process.
async function writeAll(records: PluginApprovalRecord[]) {
  await Storage.writeJsonAtomic(approvalPath(), `${JSON.stringify(records, null, 2)}\n`)
}

export const readApprovals = readAll

export async function writeApprovals(records: PluginApprovalRecord[]) {
  using _ = await Lock.write(approvalPath())
  await writeAll(records)
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
  const records = (await readAll())
    .filter((record) => record.pluginId === pluginId)
    .sort((left, right) => right.approvedAt - left.approvedAt)
  return manifest ? records.find((record) => verifyApproval(record, manifest)) : records[0]
}

export async function saveApproval(record: PluginApprovalRecord) {
  using _ = await Lock.write(approvalPath())
  const records = (await readAll()).filter((item) => item.pluginId !== record.pluginId)
  records.push(record)
  await writeAll(records)
}

export async function removeApproval(pluginId: string) {
  using _ = await Lock.write(approvalPath())
  await writeAll((await readAll()).filter((record) => record.pluginId !== pluginId))
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
