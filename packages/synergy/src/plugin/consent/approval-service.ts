import z from "zod"
import { manifestHasTrustedUI, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import {
  computeManifestHash,
  computePermissionsHash,
  permissionsHashPayload,
} from "@ericsanchezok/synergy-plugin/integrity"
import { createApprovalRecord, getApproval, type PluginApprovalRecord, verifyApproval } from "./approval-store"
import { broadenedPermissionItems, comparePluginAccess, diffPermissions } from "./diff"
import { PermissionItemSchema } from "./schema"
import { getDisabledPlugin, state as loaderState } from "../loader"
import { resolvePluginSpec } from "../spec-resolver"
import * as Lockfile from "../lockfile"
import { PluginMarketplaceRegistry } from "../marketplace-registry"
import { localRegistryPath, resolveLocalRegistryInstallSpec } from "../local-registry-store"
import { pathToFileURL } from "url"
import { ScopeContext } from "../../scope/context"

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

const ConfirmationReasonSchema = z.enum(["non_official_source", "access_expanded", "publisher_changed"])

export const ApprovalReviewSchema = z
  .object({
    target: ApprovalTargetSchema,
    pluginId: z.string(),
    name: z.string(),
    version: z.string(),
    apiVersion: z.string(),
    generation: z.string(),
    source: z.enum(["local", "official", "npm", "git", "url", "builtin"]),
    signer: z.string().optional(),
    capabilities: z.array(z.string()),
    trust: z.enum(["declarative", "trusted-import"]),
    access: z.array(PermissionItemSchema),
    added: z.array(PermissionItemSchema),
    broadened: z.array(PermissionItemSchema),
    removed: z.array(PermissionItemSchema),
    requiresConfirmation: z.boolean(),
    confirmationReason: ConfirmationReasonSchema.optional(),
    reason: z.string().optional(),
    reviewToken: z.string(),
  })
  .meta({ ref: "ApprovalReview" })

export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>

export const ApprovalApproveBodySchema = z.object({ target: ApprovalTargetSchema, reviewToken: z.string() }).strict()

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
  return target.kind === "configured"
    ? `cfg:${target.pluginId}`
    : `reg:${target.pluginId}:${target.version}:${target.source}`
}

export function generateReviewToken(
  target: ApprovalTarget,
  manifest: PluginManifestType,
  capabilities: string[],
  identity: { source?: string; signer?: string } = {},
): string {
  return hash(
    `${serializeTarget(target)}:${identity.source ?? ""}:${identity.signer ?? ""}:${computeManifestHash(manifest)}:${computePermissionsHash(manifest, capabilities)}`,
  )
}

export async function resolveRegistrySpec(
  id: string,
  version: string,
  source: "official" | "local",
): Promise<{ spec: string; source: "official" | "local"; signer?: string; official: boolean }> {
  if (source === "official") {
    const artifact = await PluginMarketplaceRegistry.verifyOfficialArtifact(id, version)
    return {
      spec: pathToFileURL(artifact.tarballPath).href,
      source,
      signer: artifact.signature.signer,
      official: true,
    }
  }
  const registry = JSON.parse(await Bun.file(localRegistryPath()).text()) as {
    plugins?: Array<Record<string, unknown>>
  }
  const entry = registry.plugins?.find((candidate) => candidate.id === id)
  if (!entry) throw new ApprovalPluginNotFoundError(`Local registry plugin not found: ${id}`)
  const versions = Array.isArray(entry.versions) ? entry.versions : []
  const matched = versions.find(
    (candidate) =>
      candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).version === version,
  )
  if (!matched) throw new ApprovalPluginNotFoundError(`Local registry version not found: ${id}@${version}`)
  return { spec: resolveLocalRegistryInstallSpec(entry, matched), source, official: false }
}

interface ResolvedTargetManifest {
  manifest: PluginManifestType
  source: "local" | "official" | "npm" | "git" | "url" | "builtin"
  spec: string
  signer?: string
  official: boolean
  oldVersion?: string
  oldApproval?: PluginApprovalRecord
}

async function resolveConfiguredTarget(pluginId: string): Promise<ResolvedTargetManifest> {
  const lockfile = await Lockfile.read()
  const disabled = await getDisabledPlugin(pluginId)
  const currentState = await loaderState()
  const loaded = currentState.loaded.find((plugin) => plugin.id === pluginId)
  const lockEntry = lockfile.plugins[pluginId]
  const spec = loaded?.spec ?? disabled?.spec ?? lockEntry?.spec
  if (!spec) throw new ApprovalPluginNotFoundError(`Plugin not configured: ${pluginId}`)
  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: ScopeContext.current.directory,
      install: !spec.startsWith("file://"),
    })
    if (resolved.manifest.id !== pluginId) {
      throw new ApprovalInvalidError(`Manifest plugin id ${resolved.manifest.id} does not match target ${pluginId}`)
    }
    return {
      manifest: resolved.manifest,
      source: lockEntry?.source ?? resolved.source,
      spec,
      official: false,
      oldVersion: loaded?.manifest.version ?? disabled?.manifest?.version ?? lockEntry?.version,
      oldApproval: await getApproval(pluginId),
    }
  } catch (error) {
    if (error instanceof ApprovalInvalidError) throw error
    throw new ApprovalInvalidError(error instanceof Error ? error.message : "Plugin spec resolution failed")
  }
}

async function resolveRegistryTarget(
  target: Extract<ApprovalTarget, { kind: "registry" }>,
): Promise<ResolvedTargetManifest> {
  const registry = await resolveRegistrySpec(target.pluginId, target.version, target.source)
  try {
    const resolved = await resolvePluginSpec(registry.spec, {
      cwd: ScopeContext.current.directory,
      install: !registry.spec.startsWith("file://"),
    })
    if (resolved.manifest.id !== target.pluginId) {
      throw new ApprovalInvalidError(
        `Manifest plugin id ${resolved.manifest.id} does not match target ${target.pluginId}`,
      )
    }
    const [oldApproval, currentState, disabled, lockfile] = await Promise.all([
      getApproval(target.pluginId),
      loaderState(),
      getDisabledPlugin(target.pluginId),
      Lockfile.read(),
    ])
    return {
      manifest: resolved.manifest,
      source: target.source,
      spec: registry.spec,
      signer: registry.signer,
      official: registry.official,
      oldVersion:
        currentState.loaded.find((plugin) => plugin.id === target.pluginId)?.manifest.version ??
        disabled?.manifest?.version ??
        lockfile.plugins[target.pluginId]?.version,
      oldApproval,
    }
  } catch (error) {
    if (error instanceof ApprovalInvalidError) throw error
    throw new ApprovalInvalidError(error instanceof Error ? error.message : "Plugin spec resolution failed")
  }
}

export async function resolveTarget(target: ApprovalTarget): Promise<ResolvedTargetManifest> {
  return target.kind === "configured" ? resolveConfiguredTarget(target.pluginId) : resolveRegistryTarget(target)
}

export function buildApprovalRecord(
  pluginId: string,
  source: ResolvedTargetManifest["source"],
  manifest: PluginManifestType,
  capabilities: string[],
  approvedBy: PluginApprovalRecord["approvedBy"] = "user",
  signer?: string,
): PluginApprovalRecord {
  return createApprovalRecord({ pluginId, source, manifest, capabilities, approvedBy, signer })
}

export async function buildApprovalReview(target: ApprovalTarget): Promise<ApprovalReview> {
  const resolved = await resolveTarget(target)
  const manifest = resolved.manifest
  const capabilities = manifest.capabilities.map((capability) => capability.id)
  if (
    target.kind === "configured" &&
    resolved.oldApproval &&
    verifyApproval(resolved.oldApproval, manifest, capabilities, { source: resolved.source })
  ) {
    throw new ApprovalNotRequiredError(`Plugin ${target.pluginId} already has sufficient access approval`)
  }
  const base = diffPermissions(target.pluginId, {
    oldVersion: resolved.oldVersion,
    newVersion: manifest.version,
    oldCapabilities: resolved.oldApproval?.approvedCapabilities ?? [],
    newCapabilities: capabilities,
  })
  const candidateGrant = permissionsHashPayload(manifest, capabilities)
  const accessChange = resolved.oldApproval
    ? comparePluginAccess(resolved.oldApproval.grant, candidateGrant)
    : "broadened"
  const publisherChanged = Boolean(
    resolved.oldApproval &&
      (resolved.oldApproval.source !== resolved.source || resolved.oldApproval.signer !== resolved.signer),
  )
  const requiresConfirmation = !resolved.oldApproval || publisherChanged || accessChange === "broadened"
  const confirmationReason = !requiresConfirmation
    ? undefined
    : !resolved.oldApproval
      ? "non_official_source"
      : publisherChanged
        ? "publisher_changed"
        : "access_expanded"
  const broadened = resolved.oldApproval
    ? broadenedPermissionItems(resolved.oldApproval.grant, candidateGrant).filter(
        (item) => !base.added.some((added) => added.key === item.key),
      )
    : []
  const reason =
    confirmationReason === "publisher_changed"
      ? "The plugin publisher or source changed."
      : confirmationReason === "access_expanded"
        ? "This update expands plugin access."
        : confirmationReason === "non_official_source"
          ? "Confirm access for this third-party plugin."
          : undefined
  return {
    target,
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    generation: manifest.artifacts.generation,
    source: resolved.source,
    signer: resolved.signer,
    capabilities,
    trust: manifestHasTrustedUI(manifest) ? "trusted-import" : "declarative",
    access: base.access,
    added: base.added,
    broadened,
    removed: base.removed,
    requiresConfirmation,
    confirmationReason,
    reason,
    reviewToken: generateReviewToken(target, manifest, capabilities, resolved),
  }
}

export async function approve(target: ApprovalTarget, reviewToken: string): Promise<PluginApprovalRecord> {
  const resolved = await resolveTarget(target)
  const manifest = resolved.manifest
  const capabilities = manifest.capabilities.map((capability) => capability.id)
  const currentToken = generateReviewToken(target, manifest, capabilities, resolved)
  if (reviewToken !== currentToken) {
    throw new ApprovalStaleReviewError(
      "The provided review token is stale. A fresh review is required.",
      await buildApprovalReview(target),
    )
  }
  return buildApprovalRecord(target.pluginId, resolved.source, manifest, capabilities, "user", resolved.signer)
}
