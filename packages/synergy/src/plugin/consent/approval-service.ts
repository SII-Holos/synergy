import z from "zod"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import {
  computeManifestHash,
  computePermissionsHash,
  getApproval,
  verifyApproval,
  type PluginApprovalRecord,
} from "./approval-store"
import { diffPermissions } from "./diff"
import { PluginPermissionDiffSchema } from "./schema"
import { riskForCapabilities } from "../capability"
import { getDisabledPlugin, state as loaderState } from "../loader"
import { resolvePluginSpec } from "../spec-resolver"
import * as Lockfile from "../lockfile"
import { PluginMarketplaceRegistry } from "../marketplace-registry"
import { localRegistryPath, resolveLocalRegistryInstallSpec } from "../local-registry-store"
import { pathToFileURL } from "url"

export const ApprovalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("configured"), pluginId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("registry"),
      pluginId: z.string(),
      version: z.string(),
      source: z.enum(["official", "local"]),
    })
    .strict(),
])

export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>

export const ApprovalReviewSchema = z
  .object({
    target: ApprovalTargetSchema,
    pluginId: z.string(),
    name: z.string(),
    version: z.string(),
    apiVersion: z.string().optional(),
    generation: z.string().optional(),
    capabilities: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
    trust: z.enum(["declarative", "trusted-import"]),
    diff: PluginPermissionDiffSchema,
    permissionsChanged: z.boolean(),
    reason: z.string().optional(),
    reviewToken: z.string(),
  })
  .meta({ ref: "ApprovalReview" })

export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>

export const ApprovalApproveBodySchema = z
  .object({
    target: ApprovalTargetSchema,
    reviewToken: z.string(),
  })
  .strict()

export type ApprovalApproveBody = z.infer<typeof ApprovalApproveBodySchema>

export class ApprovalStaleReviewError extends Error {
  readonly code = "stale_review"
  constructor(
    message: string,
    readonly review: ApprovalReview,
  ) {
    super(message)
    this.name = "ApprovalStaleReviewError"
  }
}

export class ApprovalPluginNotFoundError extends Error {
  readonly code = "plugin_not_found"
  constructor(message: string) {
    super(message)
    this.name = "ApprovalPluginNotFoundError"
  }
}

export class ApprovalNotRequiredError extends Error {
  readonly code = "approval_not_required"
  constructor(message: string) {
    super(message)
    this.name = "ApprovalNotRequiredError"
  }
}

export class ApprovalInvalidError extends Error {
  readonly code = "plugin_invalid"
  constructor(message: string) {
    super(message)
    this.name = "ApprovalInvalidError"
  }
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function serializeTarget(target: ApprovalTarget): string {
  switch (target.kind) {
    case "configured":
      return `cfg:${target.pluginId}`
    case "registry":
      return `reg:${target.pluginId}:${target.version}:${target.source}`
  }
}

export function generateReviewToken(
  target: ApprovalTarget,
  manifest: PluginManifestType,
  capabilities: string[],
): string {
  return hash(
    `${serializeTarget(target)}:${computeManifestHash(manifest)}:${computePermissionsHash(manifest, capabilities)}`,
  )
}

function verifyReviewToken(
  target: ApprovalTarget,
  manifest: PluginManifestType,
  capabilities: string[],
  token: string,
): boolean {
  return token === generateReviewToken(target, manifest, capabilities)
}

export async function resolveRegistrySpec(
  id: string,
  version: string,
  source: "official" | "local",
): Promise<{ spec: string; source: "official" | "local" }> {
  if (source === "official") {
    const artifact = await PluginMarketplaceRegistry.verifyOfficialArtifact(id, version)
    return { spec: pathToFileURL(artifact.tarballPath).href, source }
  }
  const registry = JSON.parse(await Bun.file(localRegistryPath()).text()) as {
    plugins?: Array<Record<string, unknown>>
  }
  const entry = registry.plugins?.find((e) => e.id === id)
  if (!entry) throw new ApprovalPluginNotFoundError(`Local registry plugin not found: ${id}`)
  const versions = Array.isArray(entry.versions) ? entry.versions : []
  const matched = versions.find((v) => v && typeof v === "object" && (v as Record<string, unknown>).version === version)
  if (!matched) throw new ApprovalPluginNotFoundError(`Local registry version not found: ${id}@${version}`)
  return { spec: resolveLocalRegistryInstallSpec(entry, matched), source }
}

interface ResolvedTargetManifest {
  manifest: PluginManifestType
  source: "local" | "official" | "npm" | "git" | "url" | "builtin"
  spec: string
  oldVersion?: string
  oldCapabilities?: string[]
}

async function resolveConfiguredTarget(pluginId: string): Promise<ResolvedTargetManifest> {
  const lockfile = await Lockfile.read()
  const disabled = await getDisabledPlugin(pluginId)
  const currentState = await loaderState()
  const loaded = currentState.loaded.find((p) => p.id === pluginId)
  const lockEntry = lockfile.plugins[pluginId]
  const spec = loaded?.spec ?? disabled?.spec ?? lockEntry?.spec
  if (!spec) throw new ApprovalPluginNotFoundError(`Plugin not configured: ${pluginId}`)

  let resolved
  try {
    resolved = await resolvePluginSpec(spec, { cwd: process.cwd(), install: !spec.startsWith("file://") })
  } catch (err) {
    throw new ApprovalInvalidError(err instanceof Error ? err.message : "Plugin spec resolution failed")
  }

  if (resolved.manifest.id !== pluginId) {
    throw new ApprovalInvalidError(`Manifest plugin id ${resolved.manifest.id} does not match target ${pluginId}`)
  }

  const approvals = await import("./approval-store").then((m) => m.readApprovals())
  const latestApproval = approvals.filter((r) => r.pluginId === pluginId).sort((a, b) => b.approvedAt - a.approvedAt)[0]

  return {
    manifest: resolved.manifest,
    source: resolved.source,
    spec,
    oldVersion: latestApproval?.version,
    oldCapabilities: latestApproval?.approvedCapabilities ?? [],
  }
}

async function resolveRegistryTarget(
  target: Extract<ApprovalTarget, { kind: "registry" }>,
): Promise<ResolvedTargetManifest> {
  const { spec } = await resolveRegistrySpec(target.pluginId, target.version, target.source)
  let resolved
  try {
    resolved = await resolvePluginSpec(spec, { cwd: process.cwd(), install: !spec.startsWith("file://") })
  } catch (err) {
    throw new ApprovalInvalidError(err instanceof Error ? err.message : "Plugin spec resolution failed")
  }

  if (resolved.manifest.id !== target.pluginId) {
    throw new ApprovalInvalidError(
      `Manifest plugin id ${resolved.manifest.id} does not match target ${target.pluginId}`,
    )
  }

  const approvals = await import("./approval-store").then((m) => m.readApprovals())
  const latestApproval = approvals
    .filter((r) => r.pluginId === target.pluginId)
    .sort((a, b) => b.approvedAt - a.approvedAt)[0]

  return {
    manifest: resolved.manifest,
    source: resolved.source,
    spec,
    oldVersion: latestApproval?.version,
    oldCapabilities: latestApproval?.approvedCapabilities ?? [],
  }
}

export async function resolveTarget(target: ApprovalTarget): Promise<ResolvedTargetManifest> {
  if (target.kind === "configured") return resolveConfiguredTarget(target.pluginId)
  return resolveRegistryTarget(target)
}

function trustedUI(manifest: PluginManifestType): boolean {
  return manifest.contributions.some((c) => c.kind.startsWith("ui.") && "component" in c && Boolean(c.component))
}

export function buildApprovalRecord(
  pluginId: string,
  source: ResolvedTargetManifest["source"],
  manifest: PluginManifestType,
  capabilities: string[],
): PluginApprovalRecord {
  return {
    pluginId,
    source,
    version: manifest.version,
    manifestHash: computeManifestHash(manifest),
    capabilitiesHash: computePermissionsHash(manifest, capabilities),
    approvedAt: Date.now(),
    approvedBy: "user",
    trustTier: trustedUI(manifest) ? "trusted-import" : "declarative",
    approvedCapabilities: capabilities,
    risk: riskForCapabilities(capabilities),
    status: "approved",
  }
}

export async function buildApprovalReview(target: ApprovalTarget): Promise<ApprovalReview> {
  if (target.kind === "configured") {
    const currentState = await loaderState()
    const loaded = currentState.loaded.find((p) => p.id === target.pluginId)
    if (loaded) {
      const approval = await getApproval(target.pluginId, loaded.manifest)
      if (approval && verifyApproval(approval, loaded.manifest)) {
        throw new ApprovalNotRequiredError(`Plugin ${target.pluginId} is already loaded and approved`)
      }
    }
  }

  const resolved = await resolveTarget(target)
  const manifest = resolved.manifest
  const capabilities = manifest.capabilities.map((c) => c.id)
  const token = generateReviewToken(target, manifest, capabilities)
  const diff = diffPermissions(target.pluginId, {
    oldVersion: resolved.oldVersion,
    newVersion: manifest.version,
    oldCapabilities: resolved.oldCapabilities ?? [],
    newCapabilities: capabilities,
  })

  return {
    target,
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    generation: manifest.artifacts.generation,
    capabilities,
    risk: riskForCapabilities(capabilities),
    trust: trustedUI(manifest) ? "trusted-import" : "declarative",
    diff,
    permissionsChanged: diff.requiresApproval,
    reason: diff.reason,
    reviewToken: token,
  }
}

export async function approve(target: ApprovalTarget, reviewToken: string): Promise<PluginApprovalRecord> {
  const resolved = await resolveTarget(target)
  const manifest = resolved.manifest
  const capabilities = manifest.capabilities.map((c) => c.id)

  if (!verifyReviewToken(target, manifest, capabilities, reviewToken)) {
    const freshReview = await buildApprovalReview(target)
    throw new ApprovalStaleReviewError("The provided review token is stale. A fresh review is required.", freshReview)
  }

  return buildApprovalRecord(target.pluginId, resolved.source, manifest, capabilities)
}
