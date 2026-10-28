import { runtimeFeatureAvailable } from "../runtime-features"
import { useNewTaskNavigation } from "../session/welcome/context"
import { navStart } from "@/utils/perf"
import { SidebarNavigation } from "./sidebar-navigation"
import { SidebarSectionButton } from "./sidebar-section-button"
import { useExtensionOutlet } from "@ericsanchezok/synergy-ui/context/extension-outlet"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createSessionTagFilter, type TagFilterState } from "./session-tag-filter"
import { FlipList } from "./flip-list"
import { shouldOpenProjectDisclosure } from "./project-disclosure"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import type { NavRequestState } from "@/context/layout/nav-request"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { SpaceSwitcher } from "./space-switcher"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { translateDescriptor } from "@/locales/translate"
import { sessionTags, sidebar } from "@/locales/messages"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveProjectConfirm } from "@/components/dialog/confirm-copy"
import type { LocalScope, NavEntry, ScopeNavEntry } from "@/context/layout"
import { SIDEBAR_COLLAPSE_THRESHOLD, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@/context/layout/defaults"
import { usePlatform } from "@/context/platform"
import { useProductUpdate } from "@/context/product-update"
import { SettingsDialog } from "@/components/settings"
import { listNavigation, navigationEntryLabel, subscribeNavigation, type NavigationEntry } from "@/plugin"
import { selectAppAttention, type AppAttentionNotice } from "./app-attention"
import { resolveSessionVisualState, scopeKeyForNavEntry } from "@/components/sidebar/session-visual-state"
import { setSessionDragData } from "@/utils/session-drag"
import { SidebarAttentionNotice } from "./sidebar-attention-notice"
import { SessionDraftBadge } from "./session-draft-badge"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import "./sidebar.css"
import { SlotOutlet } from "@/plugin/slot-outlet"
import {
  channelProviderGroups,
  filterGenericScopeWorktrees,
  selectVisibleProjectEntries,
  type ChannelProviderGroup as ChannelProviderGroupModel,
} from "./channel-account-model"

const ORPHAN_CHAT_GROUP_ID = "__orphan__"

interface SidebarProps {
  integrated?: boolean
  onSearchOpen: () => void
  onCreateProject: () => void
}

function runningChildTasksForEntry(globalSync: ReturnType<typeof useGlobalSync>, entry: NavEntry): boolean {
  return globalSync.cortex.some((task) => task.parentSessionID === entry.id && task.status === "running")
}

function sessionIconClassList(visual?: { tone?: string; pulse?: boolean }) {
  const tone = visual?.tone
  return {
    "sb-session-icon-wrap": true,
    "sb-session-icon-active-tone": tone === "active",
    "sb-session-icon-retry-tone": tone === "retry",
    "sb-session-icon-waiting-tone": tone === "waiting",
    "sb-session-icon-paused-tone": tone === "paused",
    "sb-session-icon-worktree-tone": tone === "worktree",
    "sb-session-icon-muted-tone": tone === "muted",
    "sb-session-icon-blueprint-tone": tone === "blueprint",
    "sb-session-icon-blueprint-running-tone": tone === "blueprint-running",
    "sb-session-icon-blueprint-waiting-tone": tone === "blueprint-waiting",
    "sb-session-icon-blueprint-audit-tone": tone === "blueprint-audit",
    "sb-session-icon-loop-tone": tone === "loop",
    "sb-session-icon-pulse": !!visual?.pulse,
  }
}

export function Sidebar(props: SidebarProps) {
  useExtensionOutlet("navigation.sidebar")
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const confirm = useConfirm()
  const platform = usePlatform()
  const navigate = useNavigate()
  const newTask = useNewTaskNavigation(navigate)
  const location = useLocation()
  const params = useParams()
  const productUpdate = useProductUpdate()
  const { _ } = useLingui()

  const isExpanded = () => layout.sidebar.opened()
  const bodyExpanded = () => props.integrated || isExpanded()
  let root: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined
  onMount(() => {
    if (!root) return
    const observer = new ResizeObserver(() => layout.sidebar.setOccupiedWidth(root!.getBoundingClientRect().width))
    observer.observe(root)
    onCleanup(() => {
      observer.disconnect()
      layout.sidebar.setOccupiedWidth(undefined)
    })
  })
  createEffect(() => {
    if (!props.integrated || isExpanded() || !panel?.contains(document.activeElement)) return
    root?.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")?.focus()
  })
  const sidebarWidth = () => layout.sidebar.width()
  const [sidebarResizing, setSidebarResizing] = createSignal(false)
  const recentEntries = createMemo(() => layout.nav.recentEntries())
  const hasMoreForProject = (scope: LocalScope) => layout.nav.navEntries()[scope.id]?.nextCursor != null
  const hasMoreRecent = createMemo(() => layout.nav.hasMoreRecent())
  const [navigationRegistryVersion, setNavigationRegistryVersion] = createSignal(0)
  const sidebarNavigation = createMemo(() => {
    navigationRegistryVersion()
    return listNavigation("sidebar").filter(
      (entry) => entry.pluginId || runtimeFeatureAvailable("navigation", entry.id, globalSDK.capabilities.has),
    )
  })
  const isNavigationActive = (entry: NavigationEntry) =>
    entry.active?.(location.pathname) ?? location.pathname === entry.path
  const navigationIcon = (entry: NavigationEntry) =>
    entry.icon ?? (entry.iconToken ? getSemanticIcon(entry.iconToken) : getSemanticIcon("plugins.main"))
  const navigationLabel = (entry: NavigationEntry) => navigationEntryLabel(entry, _)
  const providerNames = createMemo(() =>
    Object.fromEntries([
      ...globalSync.data.provider.all.map((provider) => [provider.id, provider.name]),
      ["github", "GitHub"],
    ]),
  )
  const attention = createMemo(() =>
    selectAppAttention({
      productUpdate: productUpdate.notice(),
      authHealth: globalSync.data.provider.authHealth ?? {},
      providerNames: providerNames(),
    }),
  )

  const runAttentionAction = (notice: AppAttentionNotice) => {
    const action = notice.action
    if (action.type === "product-update") {
      void productUpdate.runNoticeAction()
      return
    }
    dialog.show(() => (
      <SettingsDialog
        initialTab={action.section}
        providerFocusID={action.section === "providers" ? action.providerID : undefined}
      />
    ))
  }

  const [recentSectionOpen, setRecentSectionOpen] = createSignal(true)
  const [tagFilter, setTagFilter] = createSignal<string>()
  const [tagSearch, setTagSearch] = createSignal("")
  const [tagPickerOpen, setTagPickerOpen] = createSignal(false)
  const [tagResults, setTagResults] = createSignal<TagFilterState>({
    items: [],
    total: 0,
    nextCursor: null,
    loading: false,
  })
  const tagController = createSessionTagFilter({
    publish: setTagResults,
    fetch: async ({ tag, cursor, signal }) => {
      const result = await globalSDK.client.global.nav.recent(
        {
          tag,
          parentOnly: true,
          limit: 50,
          ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
        },
        { signal, throwOnError: true },
      )
      return result.data
    },
  })
  createEffect(
    on(
      () => [globalSDK.url, tagFilter()] as const,
      () => void tagController.select(tagFilter()),
    ),
  )
  createEffect(
    on(
      globalSDK.connected,
      (connected) => {
        if (connected) void tagController.refresh()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(isExpanded, (expanded) => {
      if (!expanded) setTagFilter(undefined)
    }),
  )
  onCleanup(tagController.dispose)
  onCleanup(
    globalSDK.event.listen((event) => {
      if (event.details.type === "session.updated" && event.details.properties.navEntry)
        tagController.update(event.details.properties.navEntry as NavEntry)
    }),
  )
  const [acknowledgingCompletions, setAcknowledgingCompletions] = createSignal(false)

  const acknowledgeAllCompletions = async () => {
    if (acknowledgingCompletions()) return
    setAcknowledgingCompletions(true)
    try {
      const result = await layout.nav.acknowledgeAllCompletionNotices()
      if ((result?.failedSessionCount ?? 0) > 0) {
        showToast({ type: "error", title: _(sidebar.markAllReadFailed) })
        return
      }
      if ((result?.acknowledgedCount ?? 0) > 0) {
        showToast({ type: "info", title: _(sidebar.markAllReadSuccess) })
      }
    } catch (error) {
      showToast({
        type: "error",
        title: _(sidebar.markAllReadFailed),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setAcknowledgingCompletions(false)
    }
  }
  const [homeSectionOpen, setHomeSectionOpen] = createSignal(false)
  const [channelSectionOpen, setChannelSectionOpen] = createSignal(false)
  const [feishuGroupOpen, setFeishuGroupOpen] = createSignal(true)
  const [githubGroupOpen, setGithubGroupOpen] = createSignal(true)
  const [backgroundSectionOpen, setBackgroundSectionOpen] = createSignal(false)
  const [projectsFlyoutOpen, setProjectsFlyoutOpen] = createSignal(false)
  const [projectsSectionOpen, setProjectsSectionOpen] = createSignal(true)

  const scopes = createMemo(() => layout.scopes.list())
  const scopeWorktrees = createMemo(() => scopes().map((scope) => scope.id))
  const scopeByWorktree = createMemo(() => new Map(scopes().map((scope) => [scope.id, scope])))

  const managedWorktrees = createMemo(() => {
    const accounts = layout.channelProjection().channelAccounts
    return new Set(accounts.flatMap((account) => account.projects.map((project) => project.directory)))
  })
  const genericScopeWorktrees = createMemo(() => filterGenericScopeWorktrees(scopeWorktrees(), managedWorktrees()))
  const managedChannelGroups = createMemo(() => channelProviderGroups(layout.channelProjection().channelAccounts))

  onCleanup(subscribeNavigation(() => setNavigationRegistryVersion((version) => version + 1)))
  const hasExpandedProject = createMemo(() => scopes().some((s) => s.expanded))
  const channelEntries = createMemo(() => layout.nav.rootNavEntries("channel"))
  const allLoadedEntries = createMemo(() => [
    ...recentEntries(),
    ...layout.nav.rootNavEntries("home"),
    ...layout.nav.rootNavEntries("channel"),
    ...layout.nav.rootNavEntries("background"),
    ...scopes().flatMap((scope) => layout.nav.projectNavEntries(scope)),
  ])
  const availableTags = createMemo(() => {
    const tags = new Set<string>()
    for (const entry of allLoadedEntries()) for (const tag of entry.tags ?? []) tags.add(tag)
    return [...tags].sort()
  })
  const filteredTags = createMemo(() => {
    const query = tagSearch().trim().toLowerCase()
    return availableTags().filter((tag) => !query || tag.toLowerCase().includes(query))
  })
  createEffect(() => {
    if (!tagPickerOpen()) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest(".sb-session-tag-filter")) setTagPickerOpen(false)
    }
    document.addEventListener("click", close)
    onCleanup(() => document.removeEventListener("click", close))
  })
  const filterEntries = (entries: NavEntry[]) => {
    const tag = tagFilter()
    return tag ? entries.filter((entry) => entry.tags?.includes(tag)) : entries
  }

  const channelGroupedEntries = createMemo(() => {
    const entries = filterEntries(channelEntries())
    const groups = new Map<string, NavEntry[]>()
    let orphanSessions: NavEntry[] = []

    for (const entry of entries) {
      const key = entry.chatId
      if (!key) {
        orphanSessions.push(entry)
        continue
      }
      const groupKey = `${entry.channelType ?? "feishu"}:${key}`
      const existing = groups.get(groupKey)
      if (existing) {
        existing.push(entry)
      } else {
        groups.set(groupKey, [entry])
      }
    }

    const result = Array.from(groups.entries())
      .map(([groupKey, sessions]) => {
        const first = sessions[0]!
        const typePrefix = first.chatType === "group" ? "[G] " : first.chatType === "dm" ? "[D] " : ""
        return {
          chatId: first.chatId!,
          channelType: first.channelType ?? "feishu",
          name: `${typePrefix}${first.chatName ?? first.chatId!.slice(-8)}`,
          sessions: sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
        }
      })
      .sort((a, b) => {
        const aTime = a.sessions[0]!.lastActivityAt
        const bTime = b.sessions[0]!.lastActivityAt
        return bTime - aTime
      })

    if (orphanSessions.length > 0) {
      result.push({
        chatId: ORPHAN_CHAT_GROUP_ID,
        channelType: "feishu",
        name: _(sidebar.orphanGroup),
        sessions: orphanSessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      })
    }

    return result
  })
  const feishuChannelGroups = createMemo(() =>
    channelGroupedEntries().filter((group) => group.channelType === "feishu"),
  )
  const githubChannelGroups = createMemo(() =>
    channelGroupedEntries().filter((group) => group.channelType === "github"),
  )

  const dir = createMemo(() => {
    if (params.dir) {
      try {
        return atob(params.dir)
      } catch {
        return undefined
      }
    }
    return undefined
  })
  const currentDirectory = createMemo(() => (dir() === "home" ? undefined : dir()))

  const handleNewSession = () => {
    newTask(base64Encode("home"))
  }

  const handleProjectClick = (worktree: string) => {
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const handleProjectToggle = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    if (layout.scopes.isSupplemental(scope)) {
      layout.scopes.toggleSupplementalExpand(scope.id)
      return
    }
    if (scope.expanded) {
      layout.scopes.collapse(scope.id)
    } else {
      layout.scopes.expand(scope.id)
    }
  }

  const handleCollapseAllProjects = (e: MouseEvent) => {
    e.stopPropagation()
    for (const scope of scopes()) {
      if (scope.expanded) layout.scopes.collapse(scope.id)
    }
  }

  const handleProjectArchive = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    const scopeID = scope.id
    const worktree = scope.id
    if (!scopeID) return
    confirm.show({
      ...archiveProjectConfirm(getScopeLabel(scope)),
      onConfirm: async () => {
        await globalSDK.client.scope.remove({ path_scopeID: scopeID })
        layout.scopes.close(worktree)
      },
    })
  }

  const handleProjectEdit = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    dialog.show(() => <DialogScopeEdit scope={scope} />)
  }

  const handleProjectPlus = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    newTask(base64Encode(scope.id))
  }
  const handleProjectPin = (scope: LocalScope) => {
    layout.scopes.pinScope(scope)
  }

  const handleSessionClick = (scope: LocalScope, entry: NavEntry) => {
    navStart({ dir: base64Encode(scope.id), to: entry.id, scopeID: scope.id, trigger: "sidebar" })
    navigate(`/${base64Encode(scope.id)}/session/${entry.id}`)
  }

  const resolveEntryRouteDirectory = (entry: NavEntry): string => {
    if (entry.scopeID === "home" || entry.scopeType === "home") return "home"
    const metadata = globalSync.data.scope.find((s) => s.id === entry.scopeID)
    if (metadata?.id) return metadata.id
    return entry.scopeID
  }

  const handleNavEntryClick = (entry: NavEntry) => {
    navStart({
      dir: base64Encode(resolveEntryRouteDirectory(entry)),
      to: entry.id,
      scopeID: entry.scopeID,
      trigger: "sidebar",
    })
    navigate(`/${base64Encode(resolveEntryRouteDirectory(entry))}/session/${entry.id}`)
  }

  const handleFlyoutSessionClick = (entry: NavEntry, worktree: string) => {
    navStart({ dir: base64Encode(worktree), to: entry.id, scopeID: entry.scopeID, trigger: "sidebar-flyout" })
    setProjectsFlyoutOpen(false)
    navigate(`/${base64Encode(worktree === "home" ? "home" : worktree)}/session/${entry.id}`)
  }

  return (
    <div
      ref={root}
      data-ui-part="navigation"
      classList={{
        "sb-root": true,
        "sb-integrated": !!props.integrated,
        "sb-collapsed": !isExpanded(),
        "sb-expanded": isExpanded(),
        "sb-resizing": sidebarResizing(),
      }}
      style={isExpanded() ? { width: `${sidebarWidth()}px` } : undefined}
    >
      <Show when={isExpanded()}>
        <ResizeHandle
          direction="horizontal"
          aria-label={_(sidebar.resize)}
          size={sidebarWidth()}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          collapseThreshold={SIDEBAR_COLLAPSE_THRESHOLD}
          onResize={layout.sidebar.resize}
          onResizeStart={() => setSidebarResizing(true)}
          onResizeEnd={() => setSidebarResizing(false)}
          onCollapse={() => layout.sidebar.close()}
        />
      </Show>
      <Show
        when={props.integrated}
        fallback={
          <>
            <div class="sb-header">
              <Tooltip value={isExpanded() ? _(sidebar.collapse) : _(sidebar.expand)} placement="right">
                <button
                  type="button"
                  class="sb-icon-btn"
                  aria-label={isExpanded() ? _(sidebar.collapse) : _(sidebar.expand)}
                  aria-expanded={isExpanded()}
                  onClick={() => layout.sidebar.toggle()}
                >
                  <Icon name={getSemanticIcon("app.sidebar")} size="normal" />
                </button>
              </Tooltip>
              <Show when={isExpanded()}>
                <Tooltip value={_(sidebar.search)} placement="right">
                  <button type="button" class="sb-icon-btn" aria-label={_(sidebar.search)} onClick={props.onSearchOpen}>
                    <Icon name={getSemanticIcon("action.search")} size="normal" />
                  </button>
                </Tooltip>
              </Show>
            </div>

            {/* Collapsed search button — only visible when sidebar is collapsed */}
            <Show when={!isExpanded()}>
              <div class="sb-collapsed-search">
                <Tooltip value={_(sidebar.search)} placement="right">
                  <button type="button" class="sb-icon-btn" aria-label={_(sidebar.search)} onClick={props.onSearchOpen}>
                    <Icon name={getSemanticIcon("action.search")} size="normal" />
                  </button>
                </Tooltip>
              </div>
            </Show>
          </>
        }
      >
        <SidebarNavigation
          expanded={isExpanded()}
          labels={{
            expand: _(sidebar.expand),
            collapse: _(sidebar.collapse),
            search: _(sidebar.search),
            newSession: _(sidebar.newSession),
          }}
          onToggle={() => layout.sidebar.toggle()}
          onSearch={props.onSearchOpen}
          onNew={handleNewSession}
          notice={attention() ? translateDescriptor(attention()!.title, { _ }) : undefined}
        />
      </Show>
      <div
        ref={panel}
        class="sb-panel"
        inert={props.integrated && !isExpanded() ? true : undefined}
        style={props.integrated ? { width: `${sidebarWidth()}px` } : undefined}
      >
        {/* Action buttons */}
        <div class="sb-actions">
          <Tooltip value={_(sidebar.newSession)} placement="right">
            <button type="button" class="sb-action-btn" aria-label={_(sidebar.newSession)} onClick={handleNewSession}>
              <Icon name={getSemanticIcon("session.new")} size="normal" />
              <Show when={bodyExpanded()}>
                <span class="sb-action-label">{_(sidebar.newSessionShort)}</span>
              </Show>
            </button>
          </Tooltip>
        </div>

        {/* Global feature buttons */}
        <div class="sb-globals">
          <For each={sidebarNavigation()}>
            {(entry) => (
              <Tooltip value={navigationLabel(entry)} placement="right">
                <button
                  type="button"
                  aria-label={navigationLabel(entry)}
                  classList={{
                    "sb-global-btn": true,
                    "sb-global-active": isNavigationActive(entry),
                  }}
                  onClick={() => navigate(entry.path)}
                >
                  <Icon name={navigationIcon(entry)} size="normal" />
                  <Show when={bodyExpanded()}>
                    <span class="sb-action-label">{navigationLabel(entry)}</span>
                  </Show>
                </button>
              </Tooltip>
            )}
          </For>
        </div>

        {/* Unified scroll region */}
        <Show
          when={bodyExpanded()}
          fallback={
            <div class="sb-projects-collapsed">
              <Tooltip value={_(sidebar.projects)} placement="right">
                <button
                  type="button"
                  aria-label={_(sidebar.projects)}
                  classList={{
                    "sb-icon-btn": true,
                    "sb-projects-flyout-trigger": true,
                  }}
                  onClick={() => setProjectsFlyoutOpen((v) => !v)}
                >
                  <Icon name={getSemanticIcon("workspace.add")} size="normal" />
                </button>
              </Tooltip>
            </div>
          }
        >
          <div class="sb-scroll">
            <Show when={layout.nav.error()}>
              <div role="alert" class="sb-section-empty">
                {_(sidebar.navigationFailed)}
              </div>
              <button
                type="button"
                class="sb-load-more-btn"
                disabled={layout.nav.loading()}
                onClick={() => void layout.nav.retry()}
              >
                {_(sidebar.retryNavigation)}
              </button>
            </Show>
            <Show when={layout.nav.scopeIndexLoaded()}>
              <div class="sb-session-tag-filter" onClick={(event) => event.stopPropagation()}>
                <Icon name={getSemanticIcon("notes.tag")} size="small" class="text-icon-weak-base" />
                <input
                  type="search"
                  aria-label={_(sessionTags.tags)}
                  placeholder={tagFilter() ? `#${tagFilter()}` : _(sessionTags.tags)}
                  value={tagSearch()}
                  onFocus={() => setTagPickerOpen(true)}
                  maxLength={40}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setTagPickerOpen(false)
                    if (event.key !== "Enter") return
                    const tag = tagSearch()
                      .trim()
                      .replace(/^(?:#\s*)+/, "")
                    setTagFilter(tag || undefined)
                    setTagSearch("")
                    setTagPickerOpen(false)
                  }}
                  onInput={(event) => {
                    setTagSearch(event.currentTarget.value)
                    setTagPickerOpen(true)
                  }}
                />
                <Show when={tagFilter()}>
                  <button
                    type="button"
                    class="sb-session-tag-filter-clear"
                    aria-label={_(sessionTags.all)}
                    onClick={() => {
                      setTagFilter(undefined)
                      setTagSearch("")
                    }}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </Show>
                <Show when={tagPickerOpen()}>
                  <div class="sb-session-tag-options">
                    <button
                      type="button"
                      classList={{ "sb-session-tag-option": true, "sb-session-tag-option-active": !tagFilter() }}
                      onClick={() => {
                        setTagFilter(undefined)
                        setTagSearch("")
                        setTagPickerOpen(false)
                      }}
                    >
                      {_(sessionTags.all)}
                    </button>
                    <For each={filteredTags()}>
                      {(tag) => (
                        <button
                          type="button"
                          classList={{
                            "sb-session-tag-option": true,
                            "sb-session-tag-option-active": tagFilter() === tag,
                          }}
                          onClick={() => {
                            setTagFilter(tag)
                            setTagSearch("")
                            setTagPickerOpen(false)
                          }}
                        >
                          #{tag}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={tagFilter()}>
              <div class="sb-root-section" aria-busy={tagResults().loading}>
                <div class="sb-projects-header">#{tagFilter()}</div>
                <SidebarSessionList
                  entries={tagResults().items}
                  activeID={params.id}
                  onSessionClick={handleNavEntryClick}
                />
                <Show when={tagResults().loading}>
                  <Spinner />
                </Show>
                <Show when={tagResults().error}>
                  <div role="alert" class="sb-section-empty">
                    {_(sessionTags.loadFailed)}
                  </div>
                  <button type="button" class="sb-load-more-btn" onClick={() => void tagController.refresh()}>
                    {_(sessionTags.retry)}
                  </button>
                </Show>
                <Show when={!tagResults().loading && !tagResults().error && tagResults().items.length === 0}>
                  <div class="sb-section-empty">{_(sessionTags.noMatches)}</div>
                </Show>
                <Show when={tagResults().nextCursor}>
                  <button
                    type="button"
                    class="sb-load-more-btn"
                    disabled={tagResults().loading}
                    onClick={() => void tagController.more()}
                  >
                    {_(sidebar.loadMore)}
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={!tagFilter()}>
              <Show
                when={layout.nav.scopeIndexLoaded()}
                fallback={
                  <Show when={!layout.nav.error()}>
                    <div class="flex flex-col items-center justify-center h-full min-h-[200px] gap-3">
                      <Spinner class="text-text-weak size-8" />
                      <span class="text-text-weak text-xs">{_(sidebar.loadingProjects)}</span>
                    </div>
                  </Show>
                }
              >
                {/* Recent */}
                <div class="sb-root-section">
                  <div class="sb-projects-header sb-recent-header">
                    <button
                      type="button"
                      class="sb-recent-toggle"
                      aria-expanded={recentSectionOpen()}
                      onClick={() => setRecentSectionOpen((v) => !v)}
                    >
                      <span class="sb-section-title">{_(sidebar.recent)}</span>
                      <Icon
                        name={recentSectionOpen() ? "chevron-down" : "chevron-right"}
                        size="small"
                        class="sb-section-chevron"
                      />
                    </button>
                    <Show when={(layout.nav.unreadCompletionCount() ?? 0) > 0}>
                      <button
                        type="button"
                        class="sb-mark-all-read"
                        disabled={acknowledgingCompletions()}
                        aria-busy={acknowledgingCompletions()}
                        onClick={() => void acknowledgeAllCompletions()}
                      >
                        {_(acknowledgingCompletions() ? sidebar.markingAllRead : sidebar.markAllRead)}
                      </button>
                    </Show>
                  </div>
                  <SidebarDisclosure open={recentSectionOpen()}>
                    <Show
                      when={recentEntries().length > 0}
                      fallback={
                        <Show
                          when={layout.nav.recentLoaded() && !layout.nav.error()}
                          fallback={
                            <Show when={layout.nav.loading()}>
                              <Spinner />
                            </Show>
                          }
                        >
                          <div class="sb-section-empty">{_(sidebar.noRecentSessions)}</div>
                        </Show>
                      }
                    >
                      <SidebarSessionList
                        entries={filterEntries(recentEntries())}
                        activeID={params.id}
                        onSessionClick={handleNavEntryClick}
                      />
                      <Show when={hasMoreRecent()}>
                        <button
                          type="button"
                          class="sb-load-more-btn"
                          onClick={() => layout.nav.loadMoreNav("__recent__")}
                        >
                          {_(sidebar.loadMore)}
                        </button>
                      </Show>
                    </Show>
                  </SidebarDisclosure>
                </div>

                {/* Home */}
                <RootNavSection
                  title={_(sidebar.home)}
                  open={homeSectionOpen}
                  onToggle={() => setHomeSectionOpen((v) => !v)}
                  entries={filterEntries(layout.nav.rootNavEntries("home"))}
                  hasMore={layout.nav.hasMoreRootNavSection("home")}
                  onLoadMore={() => layout.nav.loadMoreRootNavSection("home")}
                  activeID={params.id}
                  onSessionClick={handleNavEntryClick}
                />

                {/* Channel */}
                <Show when={globalSDK.capabilities.has("channels")}>
                  <div class="sb-root-section">
                    <SidebarSectionButton
                      class="sb-projects-header"
                      onClick={() => setChannelSectionOpen((v) => !v)}
                      open={channelSectionOpen()}
                    >
                      <span class="sb-section-title">{_(sidebar.channel)}</span>
                      <Icon
                        name={channelSectionOpen() ? "chevron-down" : "chevron-right"}
                        size="small"
                        class="sb-section-chevron"
                      />
                    </SidebarSectionButton>
                    <SidebarDisclosure open={channelSectionOpen()}>
                      <Show
                        when={channelGroupedEntries().length > 0 || managedChannelGroups().length > 0}
                        fallback={<div class="sb-section-empty">{_(sidebar.noSessions)}</div>}
                      >
                        <Show when={channelGroupedEntries().length > 0}>
                          <div class="sb-session-group">
                            <SidebarSectionButton
                              class="sb-session-group-header"
                              onClick={() => setFeishuGroupOpen((v) => !v)}
                              open={feishuGroupOpen()}
                            >
                              <Icon
                                name={feishuGroupOpen() ? "chevron-down" : "chevron-right"}
                                size="small"
                                class="sb-section-chevron"
                              />
                              <span>{_(sidebar.channelFeishu)}</span>
                            </SidebarSectionButton>
                            <SidebarDisclosure open={feishuGroupOpen()}>
                              <For each={feishuChannelGroups()}>
                                {(group) => (
                                  <ChannelChatPartnerGroup
                                    name={group.name}
                                    sessions={group.sessions}
                                    activeID={params.id}
                                    onSessionClick={handleNavEntryClick}
                                  />
                                )}
                              </For>
                            </SidebarDisclosure>
                          </div>
                          <Show when={githubChannelGroups().length > 0}>
                            <div class="sb-session-group">
                              <SidebarSectionButton
                                class="sb-session-group-header"
                                onClick={() => setGithubGroupOpen((v) => !v)}
                                open={githubGroupOpen()}
                              >
                                <Icon
                                  name={githubGroupOpen() ? "chevron-down" : "chevron-right"}
                                  size="small"
                                  class="sb-section-chevron"
                                />
                                <span>{_(sidebar.channelGithub)}</span>
                              </SidebarSectionButton>
                              <SidebarDisclosure open={githubGroupOpen()}>
                                <For each={githubChannelGroups()}>
                                  {(group) => (
                                    <ChannelChatPartnerGroup
                                      name={group.name}
                                      sessions={group.sessions}
                                      activeID={params.id}
                                      onSessionClick={handleNavEntryClick}
                                    />
                                  )}
                                </For>
                              </SidebarDisclosure>
                            </div>
                          </Show>
                          <Show when={layout.nav.hasMoreRootNavSection("channel")}>
                            <button
                              type="button"
                              class="sb-load-more-btn"
                              onClick={() => layout.nav.loadMoreRootNavSection("channel")}
                            >
                              {_(sidebar.loadMore)}
                            </button>
                          </Show>
                        </Show>
                        <For each={managedChannelGroups()}>
                          {(group) => (
                            <ChannelProviderGroup group={group} _={_}>
                              <For each={group.projects}>
                                {(project) => (
                                  <SidebarProjectGroup
                                    scope={() => layout.scopes.managed(project.directory)}
                                    activeID={params.id}
                                    currentDirectory={currentDirectory()}
                                    isSupplemental={(scope) => layout.scopes.isSupplemental(scope)}
                                    navLoaded={(scope) => !!layout.nav.navEntries()[scope.id]}
                                    navRequest={(scope) => layout.nav.scopeRequestState(scope.id)}
                                    projectNavEntries={(scope) => filterEntries(layout.nav.projectNavEntries(scope))}
                                    hasMoreForProject={hasMoreForProject}
                                    managedProject={project.managedProject}
                                    onProjectToggle={handleProjectToggle}
                                    onProjectClick={handleProjectClick}
                                    onProjectPlus={handleProjectPlus}
                                    onProjectEdit={handleProjectEdit}
                                    onProjectArchive={handleProjectArchive}
                                    onProjectPin={handleProjectPin}
                                    onLoadScopeNav={(scope) => layout.nav.loadScopeNav(scope.id)}
                                    onLoadMore={(scope) => layout.nav.loadMoreNav(scope.id)}
                                    activeSessionID={params.id}
                                    onSessionClick={handleSessionClick}
                                    _={_}
                                  />
                                )}
                              </For>
                            </ChannelProviderGroup>
                          )}
                        </For>
                      </Show>
                    </SidebarDisclosure>
                  </div>
                </Show>

                {/* Background */}
                <RootNavSection
                  title={_(sidebar.background)}
                  open={backgroundSectionOpen}
                  onToggle={() => setBackgroundSectionOpen((v) => !v)}
                  entries={filterEntries(layout.nav.rootNavEntries("background"))}
                  hasMore={layout.nav.hasMoreRootNavSection("background")}
                  onLoadMore={() => layout.nav.loadMoreRootNavSection("background")}
                  activeID={params.id}
                  onSessionClick={handleNavEntryClick}
                />

                {/* Projects */}
                <div class="sb-projects">
                  <div class="sb-projects-header sb-projects-header-actions">
                    <SidebarSectionButton
                      class="sb-projects-section-toggle"
                      onClick={() => setProjectsSectionOpen((v) => !v)}
                      open={projectsSectionOpen()}
                    >
                      <span class="sb-section-title">{_(sidebar.projects)}</span>
                      <Icon
                        name={projectsSectionOpen() ? "chevron-down" : "chevron-right"}
                        size="small"
                        class="sb-section-chevron"
                      />
                    </SidebarSectionButton>
                    <span class="sb-projects-header-spacer" />
                    <Show when={hasExpandedProject()}>
                      <Tooltip value={_(sidebar.collapseAllProjects)} placement="top">
                        <button
                          type="button"
                          class="sb-projects-header-expand-all"
                          aria-label={_(sidebar.collapseAllProjects)}
                          onClick={(e) => handleCollapseAllProjects(e)}
                        >
                          <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
                        </button>
                      </Tooltip>
                    </Show>
                    <Show when={globalSDK.capabilities.has("workbench")}>
                      <Tooltip value={_(sidebar.addProject)} placement="top">
                        <button
                          type="button"
                          class="sb-projects-header-plus"
                          aria-label={_(sidebar.addProject)}
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onCreateProject()
                          }}
                        >
                          <Icon name={getSemanticIcon("action.add")} size="small" />
                        </button>
                      </Tooltip>
                    </Show>
                  </div>

                  <SidebarDisclosure open={projectsSectionOpen()}>
                    <FlipList entries={genericScopeWorktrees()} selector="[data-scope-id]" dataKey="scopeId">
                      <For each={genericScopeWorktrees()}>
                        {(worktree) => (
                          <SidebarProjectGroup
                            scope={() => scopeByWorktree().get(worktree)}
                            activeID={params.id}
                            currentDirectory={currentDirectory()}
                            isSupplemental={(scope) => layout.scopes.isSupplemental(scope)}
                            navLoaded={(scope) => !!layout.nav.navEntries()[scope.id]}
                            navRequest={(scope) => layout.nav.scopeRequestState(scope.id)}
                            projectNavEntries={(scope) => filterEntries(layout.nav.projectNavEntries(scope))}
                            hasMoreForProject={hasMoreForProject}
                            onProjectToggle={handleProjectToggle}
                            onProjectClick={handleProjectClick}
                            onProjectPlus={handleProjectPlus}
                            onProjectEdit={handleProjectEdit}
                            onProjectArchive={handleProjectArchive}
                            onProjectPin={handleProjectPin}
                            onLoadScopeNav={(scope) => layout.nav.loadScopeNav(scope.id)}
                            onLoadMore={(scope) => layout.nav.loadMoreNav(scope.id)}
                            activeSessionID={params.id}
                            onSessionClick={handleSessionClick}
                            _={_}
                          />
                        )}
                      </For>
                    </FlipList>
                  </SidebarDisclosure>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        <SidebarAttentionNotice notice={attention()} isExpanded={bodyExpanded()} onAction={runAttentionAction} />

        {/* Plugin footer slot */}
        <SlotOutlet slot="sidebar.footer" />

        {/* Projects flyout (collapsed mode only) */}
        <Show when={!bodyExpanded() && projectsFlyoutOpen()}>
          <div class="sb-projects-flyout-backdrop" onClick={() => setProjectsFlyoutOpen(false)} />
          <div class="sb-projects-flyout">
            <div class="sb-flyout-header">{_(sidebar.projectsFlyout)}</div>
            <For each={scopes()}>
              {(scope) => {
                const sessions = createMemo(() => filterEntries(layout.nav.projectNavEntries(scope)))
                return (
                  <div class="sb-flyout-project-group">
                    <button
                      type="button"
                      class="sb-flyout-project-row"
                      onClick={() => {
                        setProjectsFlyoutOpen(false)
                        handleProjectClick(scope.id)
                      }}
                    >
                      <Icon name={getSemanticIcon("workspace.main")} size="small" />
                      <span class="sb-flyout-project-name">{getScopeLabel(scope)}</span>
                    </button>
                    <SidebarSessionList
                      entries={sessions()}
                      scope={scope}
                      activeID={params.id}
                      flyout
                      onSessionClick={(session) => handleFlyoutSessionClick(session, scope.id)}
                    />
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
      <div class="sb-space-footer">
        <SpaceSwitcher
          expanded={isExpanded()}
          onSettings={(section) => dialog.show(() => <SettingsDialog initialTab={section} />)}
          onRepository={() => platform.openLink("https://github.com/SII-Holos/synergy")}
        />
      </div>
    </div>
  )
}
function SidebarProjectGroup(props: {
  scope: () => LocalScope | undefined
  activeID?: string
  currentDirectory?: string
  isSupplemental: (scope: LocalScope) => boolean
  navLoaded: (scope: LocalScope) => boolean
  navRequest: (scope: LocalScope) => NavRequestState | undefined
  projectNavEntries: (scope: LocalScope) => NavEntry[]
  hasMoreForProject: (scope: LocalScope) => boolean
  managedProject?: NonNullable<ScopeNavEntry["managedProject"]>
  onProjectToggle: (event: MouseEvent, scope: LocalScope) => void
  onProjectClick: (worktree: string) => void
  onProjectPlus: (event: MouseEvent, scope: LocalScope) => void
  onProjectEdit: (event: MouseEvent, scope: LocalScope) => void
  onProjectArchive: (event: MouseEvent, scope: LocalScope) => void
  onProjectPin: (scope: LocalScope) => void
  onLoadScopeNav: (scope: LocalScope) => void
  onLoadMore: (scope: LocalScope) => void
  activeSessionID?: string
  onSessionClick: (scope: LocalScope, entry: NavEntry) => void
  _: ReturnType<typeof useLingui>["_"]
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  let toggle: HTMLButtonElement | undefined
  const isSupplemental = createMemo(() => {
    const scope = props.scope()
    return scope ? props.isSupplemental(scope) : false
  })
  const navLoaded = createMemo(() => {
    const scope = props.scope()
    return scope ? props.navLoaded(scope) : false
  })
  const navRequest = createMemo(() => {
    const scope = props.scope()
    return scope ? props.navRequest(scope) : undefined
  })
  const disclosureOpen = createMemo(() =>
    shouldOpenProjectDisclosure({
      expanded: !!props.scope()?.expanded,
      isSupplemental: isSupplemental(),
      navLoaded: navLoaded(),
      navError: navRequest()?.error,
    }),
  )
  const sessionsLoading = createMemo(() => !!props.scope()?.expanded && !!navRequest()?.loading && !navLoaded())
  const entries = createMemo(() => {
    const scope = props.scope()
    return scope ? props.projectNavEntries(scope) : []
  })
  const activeSessionVisible = createMemo(() => {
    const scope = props.scope()
    const activeID = props.activeSessionID
    if (!scope?.expanded || !activeID) return false
    if (isSupplemental() && !navLoaded()) return false
    return entries().some((entry) => entry.id === activeID)
  })
  const isActive = createMemo(() => {
    const scope = props.scope()
    return !!scope && scope.id === props.currentDirectory && !activeSessionVisible()
  })

  return (
    <Show when={props.scope()}>
      <div class="sb-project-group" data-scope-id={props.scope()?.id || props.scope()?.id}>
        <div
          classList={{
            "sb-project-row": true,
            "sb-project-active": isActive(),
            "sb-project-expanded": !!props.scope()?.expanded,
          }}
        >
          <button
            type="button"
            class="sb-project-chevron-btn"
            ref={toggle}
            aria-label={props.scope()?.expanded ? props._(sidebar.collapseProject) : props._(sidebar.expandProject)}
            aria-expanded={props.scope()?.expanded}
            aria-busy={sessionsLoading() || undefined}
            onClick={(event) => {
              const scope = props.scope()
              if (scope) props.onProjectToggle(event, scope)
            }}
          >
            <Show
              when={sessionsLoading()}
              fallback={<Icon name={props.scope()?.expanded ? "chevron-down" : "chevron-right"} size="small" />}
            >
              <Spinner class="size-3" />
            </Show>
          </button>
          <button
            type="button"
            class="sb-project-body"
            onClick={() => {
              const scope = props.scope()
              if (scope) props.onProjectClick(scope.id)
            }}
          >
            <Icon name={getSemanticIcon("workspace.main")} size="normal" class="sb-project-folder" />
            <span class="sb-project-name">{props.scope() ? getScopeLabel(props.scope()!) : ""}</span>
          </button>
          <div class="sb-project-actions">
            <KobaltePopover open={menuOpen()} onOpenChange={setMenuOpen} placement="bottom-end" gutter={6}>
              <KobaltePopover.Trigger
                type="button"
                classList={{
                  "sb-project-menu-btn": true,
                  "sb-project-menu-active": menuOpen(),
                }}
                aria-label={props._(sidebar.projectMenu)}
              >
                <Icon name={getSemanticIcon("action.more")} size="small" />
              </KobaltePopover.Trigger>
              <button
                type="button"
                class="sb-project-plus-btn"
                aria-label={props._(sidebar.newSession)}
                onClick={(event) => {
                  const scope = props.scope()
                  if (scope) props.onProjectPlus(event, scope)
                }}
              >
                <Icon name={getSemanticIcon("notes.create")} size="small" />
              </button>
              <KobaltePopover.Portal>
                <KobaltePopover.Content class="sb-project-menu" onClick={(event) => event.stopPropagation()}>
                  <KobaltePopover.Title class="sr-only">{props._(sidebar.projectMenu)}</KobaltePopover.Title>
                  <button
                    type="button"
                    class="sb-menu-item"
                    onClick={() => {
                      const scope = props.scope()
                      if (scope) {
                        setMenuOpen(false)
                        props.onProjectPin(scope)
                      }
                    }}
                  >
                    <Icon name={getSemanticIcon("action.pin")} size="small" />
                    <span>{props.scope()?.pinned ? props._(sidebar.unpin) : props._(sidebar.pin)}</span>
                  </button>
                  <button
                    type="button"
                    class="sb-menu-item"
                    onClick={(event) => {
                      const scope = props.scope()
                      if (scope) props.onProjectEdit(event, scope)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.rename")} size="small" />
                    <span>{props._(sidebar.edit)}</span>
                  </button>
                  <button
                    type="button"
                    class="sb-menu-item sb-menu-item-danger"
                    onClick={(event) => {
                      const scope = props.scope()
                      if (scope) props.onProjectArchive(event, scope)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.remove")} size="small" />
                    <span>{props._(sidebar.archive)}</span>
                  </button>
                </KobaltePopover.Content>
              </KobaltePopover.Portal>
            </KobaltePopover>
          </div>
        </div>

        <SidebarDisclosure open={disclosureOpen()}>
          <Show when={!navLoaded() && (isSupplemental() || navRequest()?.error)}>
            <div class="sb-sessions">
              <button
                type="button"
                class="sb-load-more-btn"
                disabled={sessionsLoading()}
                onClick={() => {
                  const scope = props.scope()
                  if (scope) {
                    toggle?.focus()
                    props.onLoadScopeNav(scope)
                  }
                }}
              >
                {props._(navRequest()?.error ? sidebar.retryNavigation : sidebar.loadSessions)}
              </button>
            </div>
          </Show>
          <Show when={navLoaded()}>
            <GroupedSessionList
              entries={entries()}
              scope={props.scope()}
              activeID={props.activeID}
              managedProject={props.managedProject}
              onSessionClick={(entry) => {
                const scope = props.scope()
                if (scope) props.onSessionClick(scope, entry)
              }}
            />
            <Show when={props.scope() && props.hasMoreForProject(props.scope()!)}>
              <div class="sb-sessions">
                <button
                  type="button"
                  class="sb-load-more-btn"
                  onClick={() => {
                    const scope = props.scope()
                    if (scope) props.onLoadMore(scope)
                  }}
                >
                  {props._(sidebar.loadMore)}
                </button>
              </div>
            </Show>
          </Show>
        </SidebarDisclosure>
      </div>
    </Show>
  )
}

function SidebarSessionList(props: {
  entries: NavEntry[]
  scope?: LocalScope
  activeID?: string
  flyout?: boolean
  stopPropagation?: boolean
  onSessionClick: (entry: NavEntry) => void
}) {
  const entryIDs = createMemo(() => props.entries.map((entry) => entry.id))
  const entryByID = createMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])))

  return (
    <FlipList entries={entryIDs()} class={props.flyout ? "sb-flyout-sessions" : "sb-sessions"}>
      <For each={entryIDs()}>
        {(id) => {
          const entry = createMemo(() => entryByID().get(id))
          return (
            <Show when={entry()}>
              <SidebarSessionRow
                entry={entry()!}
                scope={props.scope}
                active={id === props.activeID}
                flyout={props.flyout}
                onClick={(event) => {
                  const navEntry = entry()
                  if (!navEntry) return
                  if (props.stopPropagation) event.stopPropagation()
                  props.onSessionClick(navEntry)
                }}
              />
            </Show>
          )
        }}
      </For>
    </FlipList>
  )
}

function SidebarDisclosure(props: { open: boolean; class?: string; children: JSX.Element }) {
  return (
    <div
      class={`sb-disclosure ${props.class ?? ""}`}
      classList={{ "sb-disclosure-open": props.open }}
      aria-hidden={!props.open}
      inert={!props.open}
    >
      <div class="sb-disclosure-inner">{props.children}</div>
    </div>
  )
}

// --- RootNavSection: reusable collapsible section for Home / Channel / Background ---

function RootNavSection(props: {
  title: string
  open: () => boolean
  onToggle: () => void
  entries: NavEntry[]
  hasMore: boolean
  onLoadMore: () => void
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const { _ } = useLingui()
  return (
    <div class="sb-root-section">
      <SidebarSectionButton class="sb-projects-header" onClick={props.onToggle} open={props.open()}>
        <span class="sb-section-title">{props.title}</span>
        <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
      </SidebarSectionButton>
      <SidebarDisclosure open={props.open()}>
        <Show when={props.entries.length > 0} fallback={<div class="sb-section-empty">{_(sidebar.noSessions)}</div>}>
          <SidebarSessionList entries={props.entries} activeID={props.activeID} onSessionClick={props.onSessionClick} />
          <Show when={props.hasMore}>
            <button type="button" class="sb-load-more-btn" onClick={props.onLoadMore}>
              {_(sidebar.loadMore)}
            </button>
          </Show>
        </Show>
      </SidebarDisclosure>
    </div>
  )
}

function GroupedSessionList(props: {
  entries: NavEntry[]
  scope?: LocalScope
  activeID?: string
  managedProject?: NonNullable<ScopeNavEntry["managedProject"]>
  onSessionClick: (entry: NavEntry) => void
}) {
  const entries = createMemo(() => selectVisibleProjectEntries(props.entries, props.managedProject))

  return (
    <SidebarSessionList
      entries={entries()}
      scope={props.scope}
      activeID={props.activeID}
      stopPropagation
      onSessionClick={props.onSessionClick}
    />
  )
}

function ChannelChatPartnerGroup(props: {
  name: string
  sessions: NavEntry[]
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const [open, setOpen] = createSignal(true)

  return (
    <div class="sb-channel-partner-group">
      <SidebarSectionButton class="sb-session-group-header" onClick={() => setOpen((v) => !v)} open={open()}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
        <span>{props.name}</span>
      </SidebarSectionButton>
      <SidebarDisclosure open={open()}>
        <SidebarSessionList entries={props.sessions} activeID={props.activeID} onSessionClick={props.onSessionClick} />
      </SidebarDisclosure>
    </div>
  )
}

function ChannelProviderGroup(props: {
  group: ChannelProviderGroupModel
  _: ReturnType<typeof useLingui>["_"]
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(true)

  return (
    <div class="sb-channel-account-group">
      <SidebarSectionButton class="sb-session-group-header" onClick={() => setOpen((v) => !v)} open={open()}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
        <span>{props.group.label}</span>
      </SidebarSectionButton>
      <SidebarDisclosure open={open()}>
        <Show
          when={props.group.projects.length > 0}
          fallback={<div class="sb-section-empty">{props._(sidebar.noSessions)}</div>}
        >
          <div class="sb-channel-managed-projects">{props.children}</div>
        </Show>
      </SidebarDisclosure>
    </div>
  )
}

function SidebarSessionRow(props: {
  entry: NavEntry
  active: boolean
  scope?: LocalScope
  flyout?: boolean
  onClick: (event: MouseEvent) => void
}) {
  const { _ } = useLingui()
  const lingui = useLingui()
  const globalSync = useGlobalSync()
  const sdk = useGlobalSDK()

  const visual = createMemo(() =>
    resolveSessionVisualState({
      entry: props.entry,
      hasFeature: sdk.capabilities.has,
      status: globalSync.sessionStatus[props.entry.id],
      waiting:
        (globalSync.permissions[props.entry.id]?.length ?? 0) > 0 ||
        (globalSync.questions[props.entry.id]?.length ?? 0) > 0,
      runningChildTasks: runningChildTasksForEntry(globalSync, props.entry),
    }),
  )

  const sessionTooltip = createMemo(() => {
    const v = visual()
    return v ? lingui._(v.label) : ""
  })

  const handleDragStart = (event: DragEvent) => {
    const directory = scopeKeyForNavEntry(props.entry, globalSync.data.scope) ?? props.entry.scopeID
    if (!directory) return
    setSessionDragData(event, {
      id: props.entry.id,
      scopeID: directory,
      connection: sdk.url,
      title: props.entry.title || _(sidebar.untitled),
      updatedAt: props.entry.lastActivityAt,
    })
  }

  return (
    <button
      type="button"
      classList={{
        "sb-session-row": !props.flyout,
        "sb-flyout-session-row": !!props.flyout,
        "sb-session-active": props.active,
      }}
      data-session-id={props.entry.id}
      draggable={props.flyout ? "false" : "true"}
      onDragStart={handleDragStart}
      onClick={props.onClick}
    >
      <span classList={{ ...sessionIconClassList(visual()) }} title={sessionTooltip()}>
        <Icon name={visual().icon} size="small" class={props.flyout ? "sb-flyout-session-icon" : "sb-session-icon"} />
        <Show when={visual()?.completionUnread}>
          <span class="sb-session-completion-dot" />
        </Show>
      </span>
      <SessionDraftBadge
        dirty={sdk.drafts.hasDraftSession(props.entry.id)}
        sessionID={props.entry.id}
        label={_(sidebar.draftBadge)}
      />
      <span class={props.flyout ? "sb-flyout-session-title" : "sb-session-title"}>
        <span class="sb-session-title-text">{props.entry.title || _(sidebar.untitled)}</span>
      </span>
      <Show when={visual().worktree}>
        <span
          class="sb-session-worktree"
          title={_({ id: "session.state.worktree", message: "Worktree session" })}
          aria-label={_({ id: "session.state.worktree", message: "Worktree session" })}
        >
          <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
        </span>
      </Show>
      <Show when={props.entry.tags?.length}>
        <span class="sb-session-tags" title={props.entry.tags?.map((tag) => `#${tag}`).join(" ")}>
          {props.entry.tags?.map((tag) => `#${tag}`).join(" ")}
        </span>
      </Show>
    </button>
  )
}
