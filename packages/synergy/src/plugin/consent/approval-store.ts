import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginSource, TrustTier } from "../trust.js"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../global/index.js"

// ---------------------------------------------------------------------------
// Approval record data model
// ---------------------------------------------------------------------------

export interface PluginApprovalRecord {
  pluginId: string
  source: PluginSource
  version: string
  manifestHash: string
  permissionsHash: string
  approvedAt: number
  approvedBy: "user" | "policy" | "builtin"
  trustTier: TrustTier
  approvedCapabilities: string[]
  approvedNetworkDomains: string[]
  approvedUISurfaces: string[]
  risk: "low" | "medium" | "high"
}

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

function approvalPath(): string {
  return path.join(Global.Path.data, "plugin-approvals.json")
}

// ---------------------------------------------------------------------------
// JSON read / write helpers
// ---------------------------------------------------------------------------

async function readAll(): Promise<PluginApprovalRecord[]> {
  try {
    const text = await Bun.file(approvalPath()).text()
    return JSON.parse(text)
  } catch {
    return []
  }
}

async function writeAll(records: PluginApprovalRecord[]): Promise<void> {
  const p = approvalPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await Bun.write(p, JSON.stringify(records, null, 2))
}

// ---------------------------------------------------------------------------
// Public CRUD
//
// Concurrency note: reads + writes are not locked. Given the expected
// moderate number of plugins (tens, not thousands) and the infrequency of
// approval mutations, last-write-wins is acceptable for now. A file-level
// lock (or sqlite-backed store) should replace this if contention ever
// becomes a real concern.
// ---------------------------------------------------------------------------

export async function readApprovals(): Promise<PluginApprovalRecord[]> {
  return readAll()
}

export async function writeApprovals(records: PluginApprovalRecord[]): Promise<void> {
  await writeAll(records)
}

export async function getApproval(pluginId: string): Promise<PluginApprovalRecord | undefined> {
  const records = await readAll()
  return records.find((r) => r.pluginId === pluginId)
}

export async function saveApproval(record: PluginApprovalRecord): Promise<void> {
  const records = await readAll()
  const idx = records.findIndex((r) => r.pluginId === record.pluginId)
  if (idx >= 0) {
    records[idx] = record
  } else {
    records.push(record)
  }
  await writeAll(records)
}

export async function removeApproval(pluginId: string): Promise<void> {
  const records = await readAll()
  await writeAll(records.filter((r) => r.pluginId !== pluginId))
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/** Deep sort all object keys for deterministic serialization. */
function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys)
  if (obj !== null && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>)
    entries.sort(([a], [b]) => a.localeCompare(b))
    const result: Record<string, unknown> = {}
    for (const [k, v] of entries) {
      result[k] = sortKeys(v)
    }
    return result
  }
  return obj
}

function sha256(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable hash of the manifest's permission-relevant fields plus
 * the active capability list. Used to detect when re-approval is needed.
 */
export function computePermissionsHash(manifest: PluginManifest, capabilities: string[]): string {
  const normalized = {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: manifest.contributes?.ui != null ? { ui: manifest.contributes.ui } : undefined,
    hooks: manifest.permissions?.hooks ?? undefined,
  }
  return sha256(JSON.stringify(sortKeys(normalized)))
}

/**
 * Compute a stable hash of the full manifest for integrity verification.
 * The manifest is deep-key-sorted before hashing so that formatting changes
 * (e.g. key reordering) do not invalidate approvals.
 */
export function computeManifestHash(manifest: PluginManifest): string {
  // Strip top-level fields that are mutable or irrelevant to identity.
  const { contributes, lifecycle, permissions, ...identity } = manifest as PluginManifest & {
    contributes?: unknown
    lifecycle?: unknown
    permissions?: unknown
  }
  return sha256(JSON.stringify(sortKeys(identity)))
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify that a stored approval record is still valid for the given
 * manifest and capability set.
 *
 * Returns true if both the manifest and permissions hashes match the current
 * values; false if either has diverged (re-approval required).
 */
export function verifyApproval(
  record: PluginApprovalRecord,
  currentManifest: PluginManifest,
  currentCapabilities: string[],
): boolean {
  return (
    record.manifestHash === computeManifestHash(currentManifest) &&
    record.permissionsHash === computePermissionsHash(currentManifest, currentCapabilities)
  )
}
