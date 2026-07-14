import { pluginMarketplace } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { useLocale } from "@/context/locale"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { uninstallPluginConfirm } from "@/components/dialog/confirm-copy"
import { usePluginHost } from "@/plugin"
import { VerifiedBadge } from "./VerifiedBadge"
import { PermissionRiskBadge } from "../consent/PermissionRiskBadge"
import { PluginConsentDialog, type PluginConsentIntent } from "../consent/PluginConsentDialog"
import { checkUpdateAvailable } from "./install-utils"
import { MarketplacePluginIcon } from "./MarketplacePluginIcon"
import type { ApprovalReview, RegistryPluginSummary, RegistryPluginVersion } from "@ericsanchezok/synergy-sdk/client"
import type { InstalledPlugin, PluginDetail } from "./types"
import {
  collectAllPermissions,
  fallbackPluginSummary,
  isRegistryPluginNotFoundError,
  registryPluginSummary,
  toTimestamp,
} from "./plugin-detail-model"
import {
  installationLabel,
  installedPluginFromSnapshot,
  installedPluginStatusView,
  isDevelopmentPlugin,
} from "./view-model"
import type { PermissionSeverity } from "../consent/schema"

export type RegistrySource = "official" | "local"

function formatSigner(signer?: string): string | null {
  if (!signer) return null
  return `${signer.slice(0, 10)}...${signer.slice(-8)}`
}
function installErrorMessage(input: unknown): string {
  if (typeof input === "string") return input
  const records = errorRecords(input)
  for (const record of records) {
    const message = record.message
    if (typeof message === "string") return message
  }
  return input instanceof Error ? input.message : "Action failed"
}

function errorRecords(input: unknown): Record<string, unknown>[] {
  if (typeof input !== "object" || input === null) return []
  const record = input as Record<string, unknown>
  return [record, record.data, record.body, record.error].filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  )
}

function isApprovalReview(input: unknown): input is ApprovalReview {
  if (typeof input !== "object" || input === null) return false
  const review = input as Partial<ApprovalReview>
  return (
    typeof review.pluginId === "string" &&
    typeof review.name === "string" &&
    typeof review.version === "string" &&
    typeof review.reviewToken === "string" &&
    typeof review.target === "object" &&
    review.target !== null &&
    typeof review.diff === "object" &&
    review.diff !== null
  )
}

function approvalReviewFromError(input: unknown): ApprovalReview | undefined {
  for (const record of errorRecords(input)) {
    if (isApprovalReview(record.review)) return record.review
  }
  return undefined
}

function isStaleApprovalError(input: unknown): boolean {
  return errorRecords(input).some((record) => record.code === "approval_stale" || record.code === "stale_review")
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
  source?: RegistrySource
  installedPlugin?: InstalledPlugin
  onChanged?: () => void | Promise<void>
}) {
  const globalSDK = useGlobalSDK()
  const pluginHost = usePluginHost()
  const dialog = useDialog()
  const confirm = useConfirm()
  const { _ } = useLingui()
  const { controller, fmt, i18n } = useLocale()
  const [action, setAction] = createSignal<"install" | "update" | "uninstall" | "review" | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const [summary] = createResource(
    () => (props.source ? { id: props.pluginId, source: props.source } : undefined),
    async ({ id, source }) => {
      const res = await globalSDK.client.registry.plugins.search({ q: id, limit: 8, source })
      const plugins = ((res.data as { plugins: RegistryPluginSummary[] })?.plugins ?? []).map(registryPluginSummary)
      return plugins.find((plugin) => plugin.id === id || plugin.name === id) ?? null
    },
  )

  const [versions] = createResource(
    () => (props.source ? { id: props.pluginId, source: props.source } : undefined),
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

  const installedInfo = createMemo(() =>
    installedPluginFromSnapshot(props.pluginId, installedPlugins(), props.installedPlugin),
  )
  const developmentInstallation = createMemo(() => {
    const installation = installedInfo()?.installation
    return installation?.kind === "directory" ? installation : null
  })
  const sourceLabel = createMemo(() => {
    controller.activeLocale()
    if (props.source === "official") return _({ id: "app.plugin.detail.source.official", message: "Official registry" })
    if (props.source === "local") return _({ id: "app.plugin.detail.source.local", message: "Local registry" })
    const installed = installedInfo()
    return installed
      ? translateDescriptor(installationLabel(installed), i18n)
      : _({ id: "app.plugin.detail.source.installed", message: "Installed plugin" })
  })

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
    const version = installedInfo()?.version
    return version && version !== "0.0.0" ? version : null
  })
  const updateAvailable = createMemo(() => checkUpdateAvailable(latestVersion()?.version, installedVersion()))
  const installedStatus = createMemo(() => {
    const installed = installedInfo()
    return installed
      ? installedPluginStatusView(installed, isDevelopmentPlugin(installed) ? "development" : "installed")
      : null
  })
  const pluginToolsCount = createMemo(() => installedInfo()?.tools.length ?? plugin()?.tools.length ?? 0)
  const pluginOperationsCount = createMemo(() => installedInfo()?.operations.length ?? 0)
  const pluginUiCount = createMemo(() => installedInfo()?.uiContributions ?? plugin()?.uiSurfaces.length ?? 0)
  const permissions = createMemo(() => {
    const registryPermissions = collectAllPermissions(versions() ?? [])
    if (registryPermissions.length > 0) return registryPermissions
    return (installedDetail()?.capabilities ?? installedInfo()?.capabilities ?? []).map((key) => ({
      key,
      description: _({
        id: "app.plugin.detail.permission.hostCapability",
        message: "Synergy host capability {key}",
        values: { key },
      }),
      risk: installedDetail()?.risk ?? installedInfo()?.risk ?? "low",
    }))
  })
  const busy = createMemo(() => action() !== null)
  const repoUrl = createMemo(() => plugin()?.repo ?? plugin()?.homepage)
  const primaryLabel = createMemo(() => {
    if (action() === "install") return _({ id: "app.plugin.detail.action.installing", message: "Installing..." })
    if (action() === "update") return _({ id: "app.plugin.detail.action.updating", message: "Updating..." })
    if (action() === "review")
      return _({ id: "app.plugin.detail.action.loadingReview", message: "Loading review..." })
    if (installedStatus()?.canReviewPermissions)
      return _({ id: "app.plugin.detail.action.reviewPermissions", message: "Review permissions" })
    if (!installedVersion()) return _({ id: "app.plugin.detail.action.install", message: "Install" })
    if (updateAvailable())
      return _({
        id: "app.plugin.detail.action.updateTo",
        message: "Update to v{version}",
        values: { version: latestVersion()?.version ?? "" },
      })
    return _({
      id: "app.plugin.detail.action.installedVersion",
      message: "Installed v{version}",
      values: { version: installedVersion() ?? "" },
    })
  })

  async function refreshAfterMutation() {
    await refetchInstalledPlugins()
    await pluginHost.reload()
    await props.onChanged?.()
  }

  async function performInstall(kind: "install" | "update") {
    const version = latestVersion()
    const source = props.source
    if (!version || !source || busy()) return
    setAction(kind)
    setError(null)
    try {
      if (kind === "update") {
        await globalSDK.client.api.plugins.updateFromRegistry({
          pluginId: props.pluginId,
          version: version.version,
          source,
        })
      } else {
        await globalSDK.client.api.plugins.installFromRegistry({
          id: props.pluginId,
          version: version.version,
          source,
        })
      }
      await refreshAfterMutation()
    } catch (err) {
      const review = approvalReviewFromError(err)
      if (review) {
        setAction(null)
        openApprovalDialog(kind, review)
        return
      }
      setError(installErrorMessage(err))
    } finally {
      setAction(null)
    }
  }

  async function approveReview(review: ApprovalReview): Promise<ApprovalReview | undefined> {
    try {
      await globalSDK.client.api.plugins.approve({ target: review.target, reviewToken: review.reviewToken })
      await refreshAfterMutation()
      return undefined
    } catch (err) {
      const staleReview = approvalReviewFromError(err)
      if (staleReview && isStaleApprovalError(err)) return staleReview
      throw new Error(installErrorMessage(err))
    }
  }

  function openApprovalDialog(intent: PluginConsentIntent, review: ApprovalReview) {
    dialog.show(() => (
      <PluginConsentDialog intent={intent} review={review} onApprove={approveReview} onCancel={() => undefined} />
    ))
  }

  async function requestConfiguredApprovalReview() {
    if (busy()) return
    setAction("review")
    setError(null)
    try {
      const res = await globalSDK.client.api.plugins.getApprovalReview({ pluginId: props.pluginId })
      if (res.data) openApprovalDialog("reapprove", res.data)
    } catch (err) {
      setError(installErrorMessage(err))
    } finally {
      setAction(null)
    }
  }

  async function performUninstall() {
    if (busy() || !installedInfo()) return
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
    if (busy() || !installedInfo()) return
    confirm.show({
      ...uninstallPluginConfirm(plugin()?.name ?? props.pluginId),
      onConfirm: performUninstall,
      onConfirmed: () => dialog.close(),
    })
  }

  return (
    <Dialog
      title={<span class="sr-only">{plugin()?.name ?? props.pluginId}</span>}
      action={
        <button
          type="button"
          class="plugin-detail-close"
          aria-label={_({ id: "app.plugin.detail.close", message: "Close plugin details" })}
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
              <span>{_({ id: "app.plugin.detail.loading", message: "Loading plugin..." })}</span>
            </div>
          }
        >
          <Show
            when={plugin()}
            fallback={
              <div class="plugin-detail-empty">
                <Icon name={getSemanticIcon("action.search")} size="large" class="text-icon-weak-base" />
                <span class="plugin-detail-empty-title">
                  {_({ id: "app.plugin.detail.notFound", message: "Plugin not found" })}
                </span>
                <span class="plugin-detail-empty-text">
                  {_({
                    id: "app.plugin.detail.notFoundInRegistry",
                    message: "{pluginId} does not exist in this registry.",
                    values: { pluginId: props.pluginId },
                  })}
                </span>
              </div>
            }
          >
            {(current) => (
              <>
                <section class="plugin-detail-hero">
                  <MarketplacePluginIcon plugin={current()} class="plugin-detail-hero-icon" />
                  <div class="plugin-detail-title-block">
                    <div class="plugin-detail-name-row">
                      {/* plugin.name is author content — pass through */}
                      <h2>{current().name}</h2>
                      <Show when={current().latestVersion}>
                        <span class="plugin-detail-version-pill">
                          {_(pluginMarketplace.versionLabel.id, { version: current().latestVersion })}
                        </span>
                      </Show>
                    </div>
                    {/* description is author content; fallback is host chrome */}
                    <p>
                      {current().description ||
                        _({ id: "app.plugin.detail.noDescription", message: "No description provided." })}
                    </p>
                    <div class="plugin-detail-badges">
                      <VerifiedBadge verified={current().verified} official={current().official} />
                      <PermissionRiskBadge risk={current().risk as PermissionSeverity} />
                      <span class="plugin-detail-chip">{sourceLabel()}</span>
                    </div>
                  </div>
                </section>

                <div class="plugin-detail-action-row">
                  <Show when={props.source || installedStatus()?.canReviewPermissions}>
                    <button
                      type="button"
                      class="plugin-detail-primary-action"
                      disabled={
                        busy() ||
                        (installedStatus()?.canReviewPermissions
                          ? false
                          : Boolean(installedVersion() && !updateAvailable()) || !latestVersion())
                      }
                      onClick={() =>
                        installedStatus()?.canReviewPermissions
                          ? void requestConfiguredApprovalReview()
                          : void performInstall(installedVersion() ? "update" : "install")
                      }
                    >
                      <Icon
                        name={
                          busy() && action() !== "uninstall"
                            ? "loader-circle"
                            : installedStatus()?.canReviewPermissions
                              ? getSemanticIcon("permission.required")
                              : installedVersion()
                                ? "refresh-ccw"
                                : "download"
                        }
                        size="small"
                        class={busy() && action() !== "uninstall" ? "animate-spin" : ""}
                      />
                      {primaryLabel()}
                    </button>
                  </Show>

                  <Show when={installedInfo()}>
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
                      {action() === "uninstall"
                        ? _({ id: "app.plugin.detail.action.uninstalling", message: "Uninstalling..." })
                        : _({ id: "app.plugin.detail.action.uninstall", message: "Uninstall" })}
                    </button>
                  </Show>

                  <Show when={repoUrl()}>
                    <a
                      class="plugin-detail-icon-link"
                      href={repoUrl()}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={_({
                        id: "app.plugin.detail.repositoryAriaLabel",
                        message: "{name} repository on {host}",
                        values: { name: current().name, host: repositoryHost(repoUrl()) },
                      })}
                      title={repositoryHost(repoUrl())}
                    >
                      <Icon name={getSemanticIcon("github.main")} size="small" />
                    </a>
                  </Show>
                </div>

                <Show when={busy()}>
                  <div
                    class="plugin-detail-progress"
                    role="progressbar"
                    aria-label={_({
                      id: "app.plugin.detail.progressAriaLabel",
                      message: "{action} plugin",
                      values: { action: action() ?? "" },
                    })}
                  />
                </Show>

                <Show when={error()}>
                  <div class="plugin-detail-error">
                    <Icon name={getSemanticIcon("state.warning")} size="small" />
                    {/* error messages come from server — pass through */}
                    <span>{error()}</span>
                  </div>
                </Show>

                <section class="plugin-detail-meta-grid">
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.latest", message: "Latest" })}
                    value={latestVersion()?.version ?? current().latestVersion ?? "—"}
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.installed", message: "Installed" })}
                    value={
                      installedVersion() ?? _({ id: "app.plugin.detail.metric.notInstalled", message: "Not installed" })
                    }
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.source", message: "Source" })}
                    value={sourceLabel()}
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.runtime", message: "Runtime" })}
                    value={latestVersion()?.runtimeMode ?? current().runtimeMode ?? "—"}
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.updated", message: "Updated" })}
                    value={fmt.relative(new Date(toTimestamp(current().updatedAt)))}
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.author", message: "Author" })}
                    value={
                      // author.name is author content; fallback is host chrome
                      current().author?.name ?? _({ id: "app.plugin.detail.metric.unknownAuthor", message: "Unknown" })
                    }
                  />
                  <DetailMetric
                    label={_({ id: "app.plugin.detail.metric.signer", message: "Signer" })}
                    value={
                      formatSigner(latestVersion()?.signature?.signer) ??
                      _({ id: "app.plugin.detail.signer.unsigned", message: "Not signed" })
                    }
                  />
                </section>

                <Show when={developmentInstallation()}>
                  {(installation) => (
                    <section class="plugin-detail-section">
                      <div class="plugin-detail-section-heading">
                        <h3>
                          {_({
                            id: "app.plugin.detail.section.developmentRegistration",
                            message: "Development registration",
                          })}
                        </h3>
                        <span>
                          {installedStatus()?.canReviewPermissions
                            ? _({ id: "app.plugin.detail.state.needsApproval", message: "Needs approval" })
                            : installedStatus()?.isDisabled
                            ? _({ id: "app.plugin.detail.state.disabled", message: "Disabled" })
                            : _({ id: "app.plugin.detail.state.active", message: "Active" })}
                        </span>
                      </div>
                      {/* installation path is user content — pass through */}
                      <div class="plugin-detail-development-path">{installation().path}</div>
                      <div class="plugin-detail-chip-cloud">
                        <Show when={installedInfo()?.apiVersion}>
                          {(apiVersion) => (
                            <span class="plugin-detail-chip">
                              {_(pluginMarketplace.pluginApiLabel.id, { version: apiVersion() })}
                            </span>
                          )}
                        </Show>
                        <Show when={installedInfo()?.generation}>
                          {(generation) => (
                            <span class="plugin-detail-chip">
                              {_({
                                id: "app.plugin.marketplace.generation.label",
                                message: "Generation {id}",
                                values: { id: generation().slice(0, 12) },
                              })}
                            </span>
                          )}
                        </Show>
                      </div>
                    </section>
                  )}
                </Show>

                <section class="plugin-detail-section">
                  <div class="plugin-detail-section-heading">
                    <h3>{_({ id: "app.plugin.detail.section.capabilities", message: "Capabilities" })}</h3>
                    <span>
                      {_({
                        id: "app.plugin.detail.section.capabilitiesSummary",
                        message: "{tools} tools · {operations} operations · {surfaces} UI surfaces",
                        values: {
                          tools: pluginToolsCount(),
                          operations: pluginOperationsCount(),
                          surfaces: pluginUiCount(),
                        },
                      })}
                    </span>
                  </div>
                  <div class="plugin-detail-chip-cloud">
                    <Show
                      when={pluginToolsCount() > 0}
                      fallback={
                        <span class="plugin-detail-muted">
                          {_({ id: "app.plugin.detail.section.noTools", message: "No tools declared" })}
                        </span>
                      }
                    >
                      {/* tool names are plugin-author content — pass through */}
                      <For each={installedInfo()?.tools.map((tool) => tool.id) ?? current().tools}>
                        {(tool) => <span class="plugin-detail-chip">{tool}</span>}
                      </For>
                    </Show>
                    <For each={installedInfo()?.operations.map((operation) => operation.id) ?? []}>
                      {(operation) => <span class="plugin-detail-chip">{operation}</span>}
                    </For>
                    {/* ui surface ids are plugin-author content — pass through */}
                    <For each={current().uiSurfaces}>
                      {(surface) => <span class="plugin-detail-chip">{surface}</span>}
                    </For>
                  </div>
                </section>

                <section class="plugin-detail-section">
                  <div class="plugin-detail-section-heading">
                    <h3>{_({ id: "app.plugin.detail.section.permissions", message: "Permissions" })}</h3>
                    <span>
                      {_({
                        id: "app.plugin.detail.section.permissionsCount",
                        message: "{count} requested",
                        values: { count: permissions().length },
                      })}
                    </span>
                  </div>
                  <Show
                    when={permissions().length > 0}
                    fallback={
                      <span class="plugin-detail-muted">
                        {_({
                          id: "app.plugin.detail.section.noPermissions",
                          message: "No special permissions declared.",
                        })}
                      </span>
                    }
                  >
                    <div class="plugin-detail-permission-list">
                      <For each={permissions()}>
                        {(permission) => (
                          <div class="plugin-detail-permission-row">
                            <div>
                              {/* permission.key is plugin data — pass through */}
                              <span class="plugin-detail-permission-key">{permission.key}</span>
                              {/* permission.description is passed through as-is */}
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
                    <h3>{_({ id: "app.plugin.detail.section.versions", message: "Versions" })}</h3>
                    <span>
                      {_({
                        id: "app.plugin.detail.section.versionsCount",
                        message: "{count} published",
                        values: { count: versions()?.length ?? 0 },
                      })}
                    </span>
                  </div>
                  <div class="plugin-detail-version-list">
                    <Show
                      when={(versions()?.length ?? 0) > 0}
                      fallback={
                        <Show
                          when={installedVersion()}
                          fallback={
                            <span class="plugin-detail-muted">
                              {_({
                                id: "app.plugin.detail.section.noVersions",
                                message: "No registry versions available.",
                              })}
                            </span>
                          }
                        >
                          {(version) => (
                            <div class="plugin-detail-version-row">
                              <div>
                                <span class="plugin-detail-version-title">
                                  {_(pluginMarketplace.versionLabel.id, { version: version() })}
                                </span>
                                <span class="plugin-detail-version-meta">
                                  {_({
                                    id: "app.plugin.detail.version.installedLocally",
                                    message: "Installed locally",
                                  })}
                                </span>
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
                              <span class="plugin-detail-version-title">
                                {_(pluginMarketplace.versionLabel.id, { version: version.version })}
                              </span>
                              <span class="plugin-detail-version-meta">
                                {fmt.date(new Date(toTimestamp(version.publishedAt)), {
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                              <Show when={version.changelog}>
                                {/* changelog content is plugin-author content — pass through */}
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
