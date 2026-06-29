import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePluginHost } from "@/plugin"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import { InstallConsentDialog } from "../consent/InstallConsentDialog"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import type {
  ApiPluginDetail,
  ApiPluginInfo,
  RegistryPermissionItem,
  RegistryPluginSummary,
  RegistryPluginVersion,
} from "@ericsanchezok/synergy-sdk/client"
import type { PermissionSeverity, PluginPermissionDiff, TrustTier } from "../consent/schema"

export type RegistrySource = "official" | "local"

type MarketplaceSummary = RegistryPluginSummary & {
  repo?: string
  homepage?: string
  downloads?: number
}

interface ApprovalRequiredError {
  code: "approval_required"
  source?: RegistrySource
  pluginId: string
  version: string
  manifest: { name: string; version: string; displayName?: string; [key: string]: unknown }
  capabilities: string[]
  diff: PluginPermissionDiff
  risk: PermissionSeverity
  artifactCacheKey?: string
  message?: string
}

type RuntimeMode = RegistryPluginSummary["runtimeMode"]
type Risk = RegistryPluginSummary["risk"]

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function arrayField(record: Record<string, unknown> | null | undefined, key: string): unknown[] {
  const value = record?.[key]
  return Array.isArray(value) ? value : []
}

function runtimeModeFromManifest(manifest: Record<string, unknown> | null | undefined): RuntimeMode {
  const mode = stringField(asRecord(manifest?.runtime), "mode")
  return mode === "in-process" || mode === "worker" || mode === "process" ? mode : "process"
}

function riskFromManifest(manifest: Record<string, unknown> | null | undefined): Risk {
  const permissions = asRecord(manifest?.permissions)
  const tools = asRecord(permissions?.tools)
  if (tools?.shell === true || tools?.filesystem === "write") return "high"
  if (tools?.network === true || tools?.filesystem === "read" || tools?.mcp === "spawn" || tools?.mcp === "invoke") {
    return "medium"
  }
  return "low"
}

function toolsFromManifest(manifest: Record<string, unknown> | null | undefined): string[] {
  const contributes = asRecord(manifest?.contributes)
  return arrayField(contributes, "tools")
    .map((tool) => stringField(asRecord(tool), "name"))
    .filter((name): name is string => Boolean(name))
}

function uiSurfacesFromManifest(manifest: Record<string, unknown> | null | undefined): string[] {
  const ui = asRecord(asRecord(manifest?.contributes)?.ui)
  if (!ui) return []
  return [
    "toolRenderers",
    "partRenderers",
    "workspacePanels",
    "globalPanels",
    "settings",
    "chatComponents",
    "themes",
    "icons",
    "routes",
    "commands",
  ].filter((key) => arrayField(ui, key).length > 0)
}

function permissionsFromManifest(manifest: Record<string, unknown> | null | undefined): RegistryPermissionItem[] {
  const permissions = asRecord(manifest?.permissions)
  const tools = asRecord(permissions?.tools)
  if (!tools) return []
  const items: RegistryPermissionItem[] = []
  const add = (key: string, risk: RegistryPermissionItem["risk"]) => {
    items.push({ key, description: `Requires ${key}`, risk })
  }
  if (tools.filesystem === "read") add("filesystem:read", "medium")
  if (tools.filesystem === "write") {
    add("filesystem:read", "medium")
    add("filesystem:write", "high")
  }
  if (tools.shell === true) add("shell", "high")
  if (tools.network === true) add("network", "medium")
  if (tools.mcp === "invoke") add("mcp:invoke", "medium")
  if (tools.mcp === "spawn") {
    add("mcp:invoke", "medium")
    add("mcp:spawn", "medium")
  }
  return items
}

function fallbackPluginSummary(input: {
  installed?: ApiPluginInfo | null
  detail?: ApiPluginDetail | null
}): MarketplaceSummary | null {
  if (!input.installed) return null
  const manifest = asRecord(input.detail?.manifest)
  const name = input.detail?.name ?? input.installed.name ?? stringField(manifest, "name") ?? input.installed.pluginId
  return {
    id: input.installed.pluginId,
    name,
    description: stringField(manifest, "description") ?? "Installed plugin",
    repo: stringField(manifest, "repository"),
    homepage: stringField(manifest, "homepage"),
    author: { name: stringField(manifest, "author") ?? "Installed locally" },
    verified: false,
    official: false,
    keywords: ["plugin"],
    latestVersion: input.installed.version,
    updatedAt: Date.now(),
    risk: riskFromManifest(manifest),
    trustTier: input.installed.trustTier,
    runtimeMode: runtimeModeFromManifest(manifest),
    uiSurfaces: uiSurfacesFromManifest(manifest),
    tools: toolsFromManifest(manifest),
    downloads: 0,
    source: "local",
  }
}

function toTimestamp(value: number | string | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Date.now()
  }
  return Date.now()
}

function timeAgo(value: number | string | undefined): string {
  const delta = Date.now() - toTimestamp(value)
  const mins = Math.floor(delta / 60000)
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(toTimestamp(value)).toLocaleDateString()
}

function formatDate(value: number | string | undefined): string {
  return new Date(toTimestamp(value)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function formatSigner(signer?: string): string {
  if (!signer) return "Not signed"
  return `${signer.slice(0, 10)}...${signer.slice(-8)}`
}

function installErrorMessage(input: unknown): string {
  if (typeof input === "string") return input
  if (typeof input === "object" && input !== null) {
    const message = (input as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return "Action failed"
}

function isApprovalRequiredError(input: unknown): input is ApprovalRequiredError {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { code?: unknown }).code === "approval_required" &&
    typeof (input as { pluginId?: unknown }).pluginId === "string" &&
    typeof (input as { version?: unknown }).version === "string"
  )
}

function collectAllPermissions(versions: RegistryPluginVersion[]): RegistryPermissionItem[] {
  const seen = new Set<string>()
  const all: RegistryPermissionItem[] = []
  for (const version of versions) {
    for (const permission of version.permissionsSummary ?? []) {
      if (seen.has(permission.key)) continue
      seen.add(permission.key)
      all.push(permission)
    }
  }
  return all
}

function repositoryHost(url: string | undefined): string {
  if (!url) return "Repository"
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return "Repository"
  }
}

export function PluginDetailDialog(props: {
  pluginId: string
  source: RegistrySource
  installedPlugin?: ApiPluginInfo
  onChanged?: () => void | Promise<void>
}) {
  const globalSDK = useGlobalSDK()
  const pluginHost = usePluginHost()
  const dialog = useDialog()
  const [action, setAction] = createSignal<"install" | "update" | "uninstall" | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [confirmingUninstall, setConfirmingUninstall] = createSignal(false)

  const [summary] = createResource(
    () => ({ id: props.pluginId, source: props.source }),
    async ({ id, source }) => {
      const res = await globalSDK.client.registry.plugins.search({ q: id, limit: 8, source })
      const plugins = ((res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []) as MarketplaceSummary[]
      return plugins.find((plugin) => plugin.id === id || plugin.name === id) ?? null
    },
  )

  const [versions] = createResource(
    () => ({ id: props.pluginId, source: props.source }),
    async ({ id, source }) => {
      const res = await globalSDK.client.registry.plugins.versions({ id, source })
      return (res.data as RegistryPluginVersion[]) ?? []
    },
  )

  const [installedPlugins, { refetch: refetchInstalledPlugins }] = createResource(
    () => true,
    async () => {
      const res = await globalSDK.client.api.plugins.list()
      return (res.data as ApiPluginInfo[]) ?? []
    },
  )

  const installedInfo = createMemo(
    () =>
      props.installedPlugin ??
      (installedPlugins() ?? []).find((plugin) => plugin.pluginId === props.pluginId || plugin.name === props.pluginId),
  )

  const [installedDetail] = createResource(
    () => installedInfo()?.pluginId,
    async (pluginId) => {
      try {
        const res = await globalSDK.client.api.plugins.get({ pluginId })
        return (res.data as ApiPluginDetail) ?? null
      } catch {
        return null
      }
    },
  )

  const plugin = createMemo(
    () => summary() ?? fallbackPluginSummary({ installed: installedInfo(), detail: installedDetail() }),
  )
  const latestVersion = createMemo(() => {
    const list = versions()
    if (!list?.length) return null
    return [...list].toSorted((a, b) => toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt))[0]
  })
  const installedVersion = createMemo(() => {
    const version = getInstalledVersion(installedPlugins() ?? [], props.pluginId)
    if (version) return version
    const propVersion = props.installedPlugin?.version
    return propVersion && propVersion !== "0.0.0" ? propVersion : null
  })
  const updateAvailable = createMemo(() => checkUpdateAvailable(latestVersion()?.version, installedVersion()))
  const permissions = createMemo(() => {
    const registryPermissions = collectAllPermissions(versions() ?? [])
    if (registryPermissions.length > 0) return registryPermissions
    return permissionsFromManifest(asRecord(installedDetail()?.manifest))
  })
  const busy = createMemo(() => action() !== null)
  const repoUrl = createMemo(() => plugin()?.repo ?? plugin()?.homepage)
  const primaryLabel = createMemo(() => {
    if (action() === "install") return "Installing..."
    if (action() === "update") return "Updating..."
    if (!installedVersion()) return "Install"
    if (updateAvailable()) return `Update to v${latestVersion()?.version ?? ""}`
    return `Installed v${installedVersion()}`
  })

  async function refreshAfterMutation() {
    await refetchInstalledPlugins()
    await pluginHost.reload()
    await props.onChanged?.()
  }

  async function performInstall(kind: "install" | "update") {
    const version = latestVersion()
    if (!version || busy()) return
    setAction(kind)
    setError(null)
    try {
      await globalSDK.client.api.plugins.installFromRegistry({
        id: props.pluginId,
        version: version.version,
        source: props.source,
      })
      await refreshAfterMutation()
    } catch (err) {
      if (isApprovalRequiredError(err)) {
        setAction(null)
        openApprovalDialog(err)
        return
      }
      setError(installErrorMessage(err))
    } finally {
      setAction(null)
    }
  }

  function openApprovalDialog(approval: ApprovalRequiredError) {
    dialog.show(() => (
      <InstallConsentDialog
        manifest={approval.manifest}
        diff={approval.diff}
        trustTier={"trusted-import" as TrustTier}
        onApprove={async () => {
          await globalSDK.client.api.plugins.approveInstall({
            pluginId: approval.pluginId,
            manifest: approval.manifest,
            capabilities: approval.capabilities,
            source: approval.source ?? props.source,
          })
          await globalSDK.client.api.plugins.installFromRegistry({
            id: approval.pluginId,
            version: approval.version,
            source: approval.source ?? props.source,
          })
          await pluginHost.reload()
          await props.onChanged?.()
        }}
        onDeny={() => undefined}
      />
    ))
  }

  async function performUninstall() {
    if (busy() || !installedVersion()) return
    if (!confirmingUninstall()) {
      setConfirmingUninstall(true)
      return
    }
    setAction("uninstall")
    setError(null)
    try {
      await globalSDK.client.api.plugins.remove({ pluginId: props.pluginId })
      setConfirmingUninstall(false)
      await refreshAfterMutation()
    } catch (err) {
      setError(installErrorMessage(err))
    } finally {
      setAction(null)
    }
  }

  return (
    <Dialog
      title={<span class="sr-only">{plugin()?.name ?? props.pluginId}</span>}
      action={
        <button
          type="button"
          class="plugin-detail-close"
          aria-label="Close plugin details"
          onClick={() => dialog.close()}
        >
          <Icon name="x" size="small" />
        </button>
      }
      class="plugin-detail-dialog"
    >
      <div class="plugin-detail-shell">
        <Show
          when={!summary.loading && !versions.loading}
          fallback={
            <div class="plugin-detail-loading">
              <div class="plugin-detail-spinner" />
              <span>Loading plugin...</span>
            </div>
          }
        >
          <Show
            when={plugin()}
            fallback={
              <div class="plugin-detail-empty">
                <Icon name="scan-search" size="large" class="text-icon-weak" />
                <span class="plugin-detail-empty-title">Plugin not found</span>
                <span class="plugin-detail-empty-text">{props.pluginId} does not exist in this registry.</span>
              </div>
            }
          >
            {(current) => (
              <>
                <section class="plugin-detail-hero">
                  <MarketplacePluginIcon plugin={current()} class="plugin-detail-hero-icon" />
                  <div class="plugin-detail-title-block">
                    <div class="plugin-detail-name-row">
                      <h2>{current().name}</h2>
                      <Show when={current().latestVersion}>
                        <span class="plugin-detail-version-pill">v{current().latestVersion}</span>
                      </Show>
                    </div>
                    <p>{current().description || "No description provided."}</p>
                    <div class="plugin-detail-badges">
                      <VerifiedBadge verified={current().verified} official={current().official} />
                      <PermissionRiskBadge risk={current().risk as PermissionSeverity} />
                      <span class="plugin-detail-chip">
                        {props.source === "official" ? "Official source" : "Local source"}
                      </span>
                    </div>
                  </div>
                </section>

                <div class="plugin-detail-action-row">
                  <button
                    type="button"
                    class="plugin-detail-primary-action"
                    disabled={busy() || Boolean(installedVersion() && !updateAvailable()) || !latestVersion()}
                    onClick={() => void performInstall(installedVersion() ? "update" : "install")}
                  >
                    <Icon
                      name={
                        busy() && action() !== "uninstall"
                          ? "loader-circle"
                          : installedVersion()
                            ? "refresh-ccw"
                            : "download"
                      }
                      size="small"
                      class={busy() && action() !== "uninstall" ? "animate-spin" : ""}
                    />
                    {primaryLabel()}
                  </button>

                  <Show when={installedVersion()}>
                    <button
                      type="button"
                      classList={{
                        "plugin-detail-secondary-action": true,
                        "is-confirming": confirmingUninstall(),
                      }}
                      disabled={busy()}
                      onClick={() => void performUninstall()}
                    >
                      <Icon
                        name={action() === "uninstall" ? "loader-circle" : "trash-2"}
                        size="small"
                        class={action() === "uninstall" ? "animate-spin" : ""}
                      />
                      {action() === "uninstall"
                        ? "Uninstalling..."
                        : confirmingUninstall()
                          ? "Confirm uninstall"
                          : "Uninstall"}
                    </button>
                  </Show>

                  <Show when={repoUrl()}>
                    <a
                      class="plugin-detail-icon-link"
                      href={repoUrl()}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${current().name} repository on ${repositoryHost(repoUrl())}`}
                      title={repositoryHost(repoUrl())}
                    >
                      <Icon name="github" size="small" />
                    </a>
                  </Show>
                </div>

                <Show when={busy()}>
                  <div class="plugin-detail-progress" role="progressbar" aria-label={`${action()} plugin`} />
                </Show>

                <Show when={error()}>
                  <div class="plugin-detail-error">
                    <Icon name="alert-triangle" size="small" />
                    <span>{error()}</span>
                  </div>
                </Show>

                <section class="plugin-detail-meta-grid">
                  <DetailMetric label="Latest" value={latestVersion()?.version ?? current().latestVersion ?? "—"} />
                  <DetailMetric label="Installed" value={installedVersion() ?? "Not installed"} />
                  <DetailMetric label="Runtime" value={latestVersion()?.runtimeMode ?? current().runtimeMode ?? "—"} />
                  <DetailMetric label="Updated" value={timeAgo(current().updatedAt)} />
                  <DetailMetric label="Author" value={current().author?.name ?? "Unknown"} />
                  <DetailMetric label="Signer" value={formatSigner(latestVersion()?.signature?.signer)} />
                </section>

                <section class="plugin-detail-section">
                  <div class="plugin-detail-section-heading">
                    <h3>Capabilities</h3>
                    <span>
                      {current().tools.length} tools · {current().uiSurfaces.length} UI surfaces
                    </span>
                  </div>
                  <div class="plugin-detail-chip-cloud">
                    <Show
                      when={current().tools.length > 0}
                      fallback={<span class="plugin-detail-muted">No tools declared</span>}
                    >
                      <For each={current().tools}>{(tool) => <span class="plugin-detail-chip">{tool}</span>}</For>
                    </Show>
                    <For each={current().uiSurfaces}>
                      {(surface) => <span class="plugin-detail-chip">{surface}</span>}
                    </For>
                  </div>
                </section>

                <section class="plugin-detail-section">
                  <div class="plugin-detail-section-heading">
                    <h3>Permissions</h3>
                    <span>{permissions().length} requested</span>
                  </div>
                  <Show
                    when={permissions().length > 0}
                    fallback={<span class="plugin-detail-muted">No special permissions declared.</span>}
                  >
                    <div class="plugin-detail-permission-list">
                      <For each={permissions()}>
                        {(permission) => (
                          <div class="plugin-detail-permission-row">
                            <div>
                              <span class="plugin-detail-permission-key">{permission.key}</span>
                              <span class="plugin-detail-permission-description">{permission.description}</span>
                            </div>
                            <PermissionRiskBadge risk={permission.risk as PermissionSeverity} />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>

                <section class="plugin-detail-section">
                  <div class="plugin-detail-section-heading">
                    <h3>Versions</h3>
                    <span>{versions()?.length ?? 0} published</span>
                  </div>
                  <div class="plugin-detail-version-list">
                    <Show
                      when={(versions()?.length ?? 0) > 0}
                      fallback={
                        <Show
                          when={installedVersion()}
                          fallback={<span class="plugin-detail-muted">No registry versions available.</span>}
                        >
                          {(version) => (
                            <div class="plugin-detail-version-row">
                              <div>
                                <span class="plugin-detail-version-title">v{version()}</span>
                                <span class="plugin-detail-version-meta">Installed locally</span>
                              </div>
                              <PermissionRiskBadge risk={current().risk as PermissionSeverity} />
                            </div>
                          )}
                        </Show>
                      }
                    >
                      <For
                        each={[...(versions() ?? [])]
                          .toSorted((a, b) => toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt))
                          .slice(0, 4)}
                      >
                        {(version) => (
                          <div class="plugin-detail-version-row">
                            <div>
                              <span class="plugin-detail-version-title">v{version.version}</span>
                              <span class="plugin-detail-version-meta">{formatDate(version.publishedAt)}</span>
                              <Show when={version.changelog}>
                                <span class="plugin-detail-version-copy">{version.changelog}</span>
                              </Show>
                            </div>
                            <PermissionRiskBadge risk={version.risk as PermissionSeverity} />
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </section>
              </>
            )}
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

function DetailMetric(props: { label: string; value: string }) {
  return (
    <div class="plugin-detail-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}
