import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { uninstallPluginConfirm } from "@/components/dialog/confirm-copy"
import { usePluginHost } from "@/plugin"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import { InstallConsentDialog } from "../consent/InstallConsentDialog"
import { getInstalledVersion, checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import type { RegistryPluginSummary, RegistryPluginVersion } from "@ericsanchezok/synergy-sdk/client"
import type { InstalledPlugin, PluginDetail } from "./types"
import {
  collectAllPermissions,
  fallbackPluginSummary,
  isRegistryPluginNotFoundError,
  toTimestamp,
  type MarketplaceSummary,
} from "./plugin-detail-model"
import type { PermissionSeverity, PluginPermissionDiff } from "../consent/schema"

export type RegistrySource = "official" | "local"

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
  installedPlugin?: InstalledPlugin
  onChanged?: () => void | Promise<void>
}) {
  const globalSDK = useGlobalSDK()
  const pluginHost = usePluginHost()
  const dialog = useDialog()
  const confirm = useConfirm()
  const [action, setAction] = createSignal<"install" | "update" | "uninstall" | null>(null)
  const [error, setError] = createSignal<string | null>(null)

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
      try {
        const res = await globalSDK.client.registry.plugins.versions({ id, source })
        return (res.data as RegistryPluginVersion[]) ?? []
      } catch (err) {
        if (isRegistryPluginNotFoundError(err, id)) return []
        throw err
      }
    },
  )

  const [installedPlugins, { refetch: refetchInstalledPlugins }] = createResource(
    () => true,
    async () => {
      const res = await globalSDK.client.api.plugins.list()
      return (res.data as InstalledPlugin[]) ?? []
    },
  )

  const installedInfo = createMemo(
    () => props.installedPlugin ?? (installedPlugins() ?? []).find((plugin) => plugin.id === props.pluginId),
  )

  const [installedDetail] = createResource(
    () => installedInfo()?.id,
    async (pluginId) => {
      try {
        const res = await globalSDK.client.api.plugins.get({ pluginId })
        return (res.data as PluginDetail) ?? null
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
    return (installedDetail()?.capabilities ?? installedInfo()?.capabilities ?? []).map((key) => ({
      key,
      description: `Synergy host capability ${key}`,
      risk: installedDetail()?.risk ?? installedInfo()?.risk ?? "low",
    }))
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
    setAction("uninstall")
    setError(null)
    try {
      await globalSDK.client.api.plugins.remove({ pluginId: props.pluginId })
      await refreshAfterMutation()
    } catch (err) {
      const message = installErrorMessage(err)
      setError(message)
      throw new Error(message)
    } finally {
      setAction(null)
    }
  }

  function requestUninstall() {
    if (busy() || !installedVersion()) return
    confirm.show({
      ...uninstallPluginConfirm(plugin()?.name ?? props.pluginId),
      onConfirm: performUninstall,
    })
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
          <Icon name={getSemanticIcon("action.close")} size="small" />
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
                <Icon name={getSemanticIcon("action.search")} size="large" class="text-icon-weak-base" />
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
                      class="plugin-detail-secondary-action"
                      disabled={busy()}
                      onClick={requestUninstall}
                    >
                      <Icon
                        name={action() === "uninstall" ? "loader-circle" : "trash-2"}
                        size="small"
                        class={action() === "uninstall" ? "animate-spin" : ""}
                      />
                      {action() === "uninstall" ? "Uninstalling..." : "Uninstall"}
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
                      <Icon name={getSemanticIcon("github.main")} size="small" />
                    </a>
                  </Show>
                </div>

                <Show when={busy()}>
                  <div class="plugin-detail-progress" role="progressbar" aria-label={`${action()} plugin`} />
                </Show>

                <Show when={error()}>
                  <div class="plugin-detail-error">
                    <Icon name={getSemanticIcon("state.warning")} size="small" />
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
