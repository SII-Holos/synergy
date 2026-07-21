import path from "path"
import fs from "fs/promises"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { Global } from "../../global/index.js"
import type { PluginSource, TrustTier } from "../trust.js"

export interface PluginApprovalRecord {
  pluginId: string
  source: PluginSource
  version: string
  manifestHash: string
  capabilitiesHash: string
  approvedAt: number
  approvedBy: "user" | "policy" | "builtin"
  trustTier: TrustTier
  approvedCapabilities: string[]
  risk: "low" | "medium" | "high"
  status: "approved" | "needsApproval"
}

function approvalPath() {
  return path.join(Global.Path.data, "plugin-approvals.json")
}

async function readAll(): Promise<PluginApprovalRecord[]> {
  try {
    const value = JSON.parse(await Bun.file(approvalPath()).text())
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function writeAll(records: PluginApprovalRecord[]) {
  const file = approvalPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await Bun.write(temporary, `${JSON.stringify(records, null, 2)}\n`)
  await fs.rename(temporary, file)
}

export const readApprovals = readAll
export const writeApprovals = writeAll

export async function getApproval(pluginId: string, manifest?: PluginManifestType) {
  const records = (await readAll())
    .filter((record) => record.pluginId === pluginId)
    .sort((left, right) => right.approvedAt - left.approvedAt)
  return manifest ? records.find((record) => verifyApproval(record, manifest)) : records[0]
}

export async function saveApproval(record: PluginApprovalRecord) {
  const records = await readAll()
  const index = records.findIndex(
    (item) => item.pluginId === record.pluginId && item.manifestHash === record.manifestHash,
  )
  if (index >= 0) records[index] = record
  else records.push(record)
  await writeAll(records)
}

export async function removeApproval(pluginId: string) {
  await writeAll((await readAll()).filter((record) => record.pluginId !== pluginId))
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  )
}

function hash(value: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(value))).digest("hex")
}

export function computePermissionsHash(manifest: PluginManifestType, capabilities?: string[]) {
  const approved = capabilities ?? manifest.capabilities.map((item) => item.id)
  return hash({
    capabilities: manifest.capabilities.filter((item) => approved.includes(item.id)),
    contributionRequirements: manifest.contributions.map((item) => ({
      kind: item.kind,
      id: item.id,
      requires: item.requires ?? [],
      ...(item.kind === "operation" ? { expose: item.expose } : {}),
      ...(item.kind.startsWith("ui.") && "component" in item && item.component ? { trustedComponent: true } : {}),
    })),
  })
}

export function computeManifestHash(manifest: PluginManifestType) {
  return hash(manifest)
}

export function verifyApproval(
  record: PluginApprovalRecord,
  manifest: PluginManifestType,
  capabilities = manifest.capabilities.map((item) => item.id),
) {
  return (
    record.status === "approved" &&
    record.manifestHash === computeManifestHash(manifest) &&
    record.capabilitiesHash === computePermissionsHash(manifest, capabilities)
  )
}
