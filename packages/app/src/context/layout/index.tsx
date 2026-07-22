import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createMediaQuery } from "@solid-primitives/media"
import { useGlobalSync } from "../global-sync"
import { useGlobalSDK } from "../global-sdk"
import { useServer } from "../server"
import { usePlatform } from "../platform"
import { Scope, Session } from "@ericsanchezok/synergy-sdk"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./scroll"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { computeDefaultWorkspaceWidth } from "./workspace"
import type { WorkbenchPanelSurface, WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { WorkbenchSurfaceState } from "../workbench/panel-model"
import { migrateWorkbenchLayout } from "../workbench/layout-migration"
import { createInitialLayoutDefaults } from "./defaults"
import { reconcile } from "solid-js/store"
import {
  applySessionToNavList,
  githubNavQuery,
  mergeNavListByID,
  navUpdateFromSession,
  orderNavEntries,
  partitionScopeNavigation,
  removeScopeFromIndex,
} from "./nav"
import { createDesktopBadgeSync } from "./desktop-badge"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import { planMessagePageApply } from "../session-message-page"
import { findSessionIndex } from "../session-collection"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
}

type WorkbenchSurfaceLayoutState = WorkbenchSurfaceState

type WorkbenchSurfacesLayoutState = {
  side?: WorkbenchSurfaceLayoutState
  bottom?: WorkbenchSurfaceLayoutState
}

export type LocalScope = Partial<Scope> & { worktree: string; expanded: boolean; pinned?: number }

export type ReviewDiffStyle = "unified" | "split"

export const SESSION_PAGE_SIZE = 20
const BOTTOM_SPACE_DEFAULT_HEIGHT = 280

// --- Nav v2 types (matches backend SessionNavEntry / ScopeNavEntry) ---

export interface NavEntry {
  id: string
  scopeID: string
  scopeType: "home" | "project"
  title: string
  category: "project" | "home" | "channel" | "background" | "github"
  lastActivityAt: number
  pinned: number
  archived: boolean
  parentID?: string
  endpointKind?: "channel"
  chatId?: string
  chatName?: string
  chatType?: string
  channelType?: string
  channelAccountId?: string
  channelTarget?:
    | { kind: "chat"; chatId: string }
    | { kind: "project"; externalProjectId: string }
    | { kind: "task"; externalProjectId: string; externalTaskId: string }
  completionNotice: {
    unread: boolean
    unreadCount: number
  }
}

export interface NavCursor {
  lastActivityAt: number
  id: string
}

export interface ScopeNavEntry {
  scopeID: string
  scopeType: "home" | "project"
  name?: string
  directory: string
  latestActivityAt: number
  sessionCount: number
  icon?: { url?: string; color?: string }
  managedProject?: {
    channelType: string
    accountId: string
    externalProjectId: string
    remoteState: "active" | "paused" | "stale" | "archived"
  }
}

const ROOT_NAV_SECTION_LIMIT = 100
const ROOT_NAV_SECTION_KEYS = ["home", "channel", "background"] as const
type RootNavSectionKey = (typeof ROOT_NAV_SECTION_KEYS)[number]
export type NavListState = { items: NavEntry[]; nextCursor: NavCursor | null; total: number }
function emptyNavList(): NavListState {
  return { items: [], nextCursor: null, total: 0 }
}
const NAV_FIRST_PAGE_LIMIT = 10
const RECENT_LIMIT = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const server = useServer()
    const platform = usePlatform()
    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("layout", ["layout.v8", "layout.v9"]), migrate: migrateWorkbenchLayout },
      createStore({
        ...createInitialLayoutDefaults(),
        review: {
          diffStyle: "split" as ReviewDiffStyle,
        },
        sessionView: {} as Record<string, SessionView>,
        workbenchSurfaces: {} as Record<string, WorkbenchSurfacesLayoutState>,
      }),
    )

    const MAX_SESSION_KEYS = 50
    const meta = { active: undefined as string | undefined, pruned: false }
    const used = new Map<string, number>()

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const parts = key.split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session ? Persist.session(dir, session, entry.key) : Persist.workspace(dir, entry.key)
          void removePersisted(target)

          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey })
        }
      }
    }

    function prune(keep?: string) {
      if (!keep) return

      const keys = new Set<string>()
      for (const key of Object.keys(store.sessionView)) keys.add(key)
      for (const key of Object.keys(store.workbenchSurfaces)) keys.add(key)
      if (keys.size <= MAX_SESSION_KEYS) return

      const score = (key: string) => {
        if (key === keep) return Number.MAX_SAFE_INTEGER
        return used.get(key) ?? 0
      }

      const ordered = Array.from(keys).sort((a, b) => score(b) - score(a))
      const drop = ordered.slice(MAX_SESSION_KEYS)
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.workbenchSurfaces[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      meta.active = sessionKey
      used.set(sessionKey, Date.now())

      if (!ready()) return
      if (meta.pruned) return

      meta.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = meta.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...(prev ?? {}), ...next }))
        prune(keep)
      },
    })

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      const active = meta.active
      if (!active) return
      meta.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", handleVisibility)

      onCleanup(() => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", handleVisibility)
        scroll.dispose()
      })
    })

    // --- Nav v2 store ---

    const [scopeIndex, setScopeIndex] = createSignal<ScopeNavEntry[]>([])
    const [navEntries, setNavEntries] = createStore<Record<string, NavListState>>({})
    const [rootNavStore, setRootNavStore] = createStore<Record<RootNavSectionKey, NavListState>>({
      home: emptyNavList(),
      channel: emptyNavList(),
      background: emptyNavList(),
    })
    const [recentEntries, setRecentEntries] = createStore<NavListState>({
      items: [],
      nextCursor: null,
      total: 0,
    })
    const [githubEntries, setGitHubEntries] = createStore<NavListState>(emptyNavList())
    const [githubConfigured, setGitHubConfigured] = createSignal(false)
    const [unreadCompletionCount, setUnreadCompletionCount] = createSignal<number>()
    const syncDesktopBadge = createDesktopBadgeSync(platform.desktopBadge?.setState)
    createEffect(() => {
      void syncDesktopBadge(unreadCompletionCount())
    })
    const navPending = new Set<string>()
    const [scopeIndexLoaded, setScopeIndexLoaded] = createSignal(false)

    const channelProjection = createMemo(() => {
      const index = scopeIndex()
      if (index.length === 0) return { genericProjects: [] as ScopeNavEntry[], channelAccounts: [] }
      return partitionScopeNavigation(index)
    })

    async function loadScopeIndex() {
      await globalSdk.client.scope.list()
      try {
        const res = await globalSdk.client.scope.index()
        if (res.data) {
          setScopeIndex(res.data as ScopeNavEntry[])
        }
      } catch (err) {
        console.warn("Failed to load scope index", err)
        // fall through; supplemental scope discovery will be unavailable until next reconnection
      } finally {
        setScopeIndexLoaded(true)
      }
    }

    async function loadGitHubConfiguration() {
      try {
        const res = await globalSdk.client.github.configured()
        const configured = res.data?.configured === true
        setGitHubConfigured(configured)
        if (configured) await loadGitHubSection()
      } catch (err) {
        setGitHubConfigured(false)
        console.warn("Failed to load GitHub configuration status", err)
      }
    }

    async function loadScopeNav(directory: string, cursor?: NavCursor) {
      if (navPending.has(directory)) return
      navPending.add(directory)
      try {
        const res = await globalSdk.client.session.index({
          directory,
          parentOnly: "true",
          limit: NAV_FIRST_PAGE_LIMIT,
          ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
        })
        if (!res.data) return
        const data = res.data
        if (cursor) {
          const existing = navEntries[directory]
          const merged = [
            ...(existing?.items ?? []),
            ...data.items.filter((e) => !(existing?.items ?? []).some((x) => x.id === e.id)),
          ] as NavEntry[]
          setNavEntries(
            directory,
            mergeNavListByID(existing, { items: merged, nextCursor: data.nextCursor, total: data.total }),
          )
        } else {
          setNavEntries(
            directory,
            mergeNavListByID(navEntries[directory], {
              items: data.items as NavEntry[],
              nextCursor: data.nextCursor,
              total: data.total,
            }),
          )
        }
      } finally {
        navPending.delete(directory)
      }
    }

    async function loadRootNavSection(category: RootNavSectionKey, cursor?: NavCursor) {
      const key = `__root_${category}`
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.session.index({
          scopeID: "home",
          category,
          parentOnly: "true",
          includeArchived: category === "channel" ? "true" : undefined,
          limit: ROOT_NAV_SECTION_LIMIT,
          ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
        })
        if (!res.data) return
        const data = res.data
        if (cursor) {
          const existing = rootNavStore[category]
          const merged = [
            ...(existing?.items ?? []),
            ...data.items.filter((e) => !(existing?.items ?? []).some((x) => x.id === e.id)),
          ] as NavEntry[]
          setRootNavStore(
            category,
            mergeNavListByID(existing, { items: merged, nextCursor: data.nextCursor, total: data.total }),
          )
        } else {
          setRootNavStore(
            category,
            mergeNavListByID(rootNavStore[category], {
              items: data.items as NavEntry[],
              nextCursor: data.nextCursor,
              total: data.total,
            }),
          )
        }
      } finally {
        navPending.delete(key)
      }
    }

    async function loadGitHubSection(cursor?: NavCursor) {
      const key = "__github__"
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.global.nav.recent(githubNavQuery(ROOT_NAV_SECTION_LIMIT, cursor))
        if (!res.data) return
        const data = res.data
        if (cursor) {
          const existing = githubEntries.items
          const merged = [...existing, ...data.items.filter((entry) => !existing.some((item) => item.id === entry.id))]
          setGitHubEntries(
            mergeNavListByID(githubEntries, {
              items: merged as NavEntry[],
              nextCursor: data.nextCursor,
              total: data.total,
            }),
          )
        } else {
          setGitHubEntries(
            mergeNavListByID(githubEntries, {
              items: data.items as NavEntry[],
              nextCursor: data.nextCursor,
              total: data.total,
            }),
          )
        }
      } finally {
        navPending.delete(key)
      }
    }

    async function loadGlobalRecent(cursor?: NavCursor) {
      const key = "__recent__"
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.global.nav.recent({
          parentOnly: true,
          limit: RECENT_LIMIT,
          ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
        })
        if (!res.data) return
        const data = res.data
        setUnreadCompletionCount(data.unreadCompletionCount)
        if (cursor) {
          const existing = recentEntries.items
          const merged = [...existing, ...data.items.filter((e) => !existing.some((x) => x.id === e.id))] as NavEntry[]
          setRecentEntries(
            mergeNavListByID(recentEntries, { items: merged, nextCursor: data.nextCursor, total: data.total }),
          )
        } else {
          setRecentEntries(
            mergeNavListByID(recentEntries, {
              items: data.items as NavEntry[],
              nextCursor: data.nextCursor,
              total: data.total,
            }),
          )
        }
      } finally {
        navPending.delete(key)
      }
    }

    function loadMoreNav(directory: string) {
      if (directory === "__recent__") {
        if (recentEntries.nextCursor) loadGlobalRecent(recentEntries.nextCursor)
        return
      }
      const entry = navEntries[directory]
      if (!entry?.nextCursor) return
      loadScopeNav(directory, entry.nextCursor)
    }

    function loadMoreRootNavSection(category: RootNavSectionKey) {
      const entry = rootNavStore[category]
      if (entry?.nextCursor) loadRootNavSection(category, entry.nextCursor)
    }

    function loadMoreGitHub() {
      if (githubEntries.nextCursor) loadGitHubSection(githubEntries.nextCursor)
    }
    async function refreshGlobalRecent() {
      const key = "__refresh__recent__"
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.global.nav.recent({
          parentOnly: true,
          limit: Math.max(RECENT_LIMIT, recentEntries.items.length),
        })
        if (!res.data) return
        const data = res.data
        setUnreadCompletionCount(data.unreadCompletionCount)
        setRecentEntries(
          mergeNavListByID(recentEntries, {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          }),
        )
      } finally {
        navPending.delete(key)
      }
    }

    async function refreshGitHubSection() {
      const key = "__refresh__github__"
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.global.nav.recent(
          githubNavQuery(Math.max(ROOT_NAV_SECTION_LIMIT, githubEntries.items.length)),
        )
        if (!res.data) return
        const data = res.data
        setGitHubEntries(
          mergeNavListByID(githubEntries, {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          }),
        )
      } finally {
        navPending.delete(key)
      }
    }

    async function refreshRootNavSection(category: RootNavSectionKey) {
      const key = `__refresh_root_${category}`
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const existing = rootNavStore[category]
        const res = await globalSdk.client.session.index({
          scopeID: "home",
          category,
          parentOnly: "true",
          includeArchived: category === "channel" ? "true" : undefined,
          limit: Math.max(ROOT_NAV_SECTION_LIMIT, existing?.items.length ?? 0),
        })
        if (!res.data) return
        const data = res.data
        setRootNavStore(
          category,
          mergeNavListByID(existing, {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          }),
        )
      } finally {
        navPending.delete(key)
      }
    }

    async function refreshScopeNav(directory: string) {
      const key = `__refresh_${directory}`
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const existing = navEntries[directory]
        const res = await globalSdk.client.session.index({
          directory,
          parentOnly: "true",
          limit: Math.max(NAV_FIRST_PAGE_LIMIT, existing?.items.length ?? 0),
        })
        if (!res.data) return
        const data = res.data
        setNavEntries(
          directory,
          mergeNavListByID(existing, {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          }),
        )
      } finally {
        navPending.delete(key)
      }
    }

    function rootNavEntriesFor(category: RootNavSectionKey): NavEntry[] {
      const entry = rootNavStore[category]
      if (!entry) return []
      return orderNavEntries(entry.items)
    }

    function hasMoreRootNavSection(category: RootNavSectionKey): boolean {
      return rootNavStore[category]?.nextCursor != null
    }

    function githubNavEntries(): NavEntry[] {
      return orderNavEntries(githubEntries.items)
    }

    function hasMoreGitHub(): boolean {
      return githubEntries.nextCursor != null
    }

    // --- Nav event refresh ---
    // On session.updated, refresh nav lists preserving current depth.
    const navRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const NAV_REFRESH_DEBOUNCE_MS = 300
    function scheduleScopeIndexRefresh() {
      const pending = navRefreshTimers.get("__scopeIndex__")
      if (pending) clearTimeout(pending)
      navRefreshTimers.set(
        "__scopeIndex__",
        setTimeout(() => {
          navRefreshTimers.delete("__scopeIndex__")
          loadScopeIndex()
        }, NAV_REFRESH_DEBOUNCE_MS),
      )
    }

    function applyScopeRemoval(scopeID: string, directory?: string) {
      const removed = removeScopeFromIndex(scopeIndex(), scopeID, directory)
      if (removed.directory) server.scopes.close(removed.directory)
      if (removed.removed) {
        setScopeIndex(removed.entries)
      }
      scheduleScopeIndexRefresh()
    }

    onMount(() => {
      const unsub = globalSdk.event.listen((e) => {
        const event = e.details as { type?: string; properties?: unknown }
        const eventProperties = isRecord(event.properties) ? event.properties : undefined
        const eventDirectory = typeof eventProperties?.directory === "string" ? eventProperties.directory : undefined
        if (event.type === "scope.removed") {
          const scopeID = typeof eventProperties?.id === "string" ? eventProperties.id : undefined
          if (scopeID) applyScopeRemoval(scopeID, eventDirectory)
          return
        }
        const eventTime = isRecord(eventProperties?.time) ? eventProperties.time : undefined
        if (event.type === "scope.updated" && eventTime?.archived) {
          const scopeID = typeof eventProperties?.id === "string" ? eventProperties.id : undefined
          if (scopeID) applyScopeRemoval(scopeID, eventDirectory)
          return
        }
        if (event.type !== "session.updated") return
        const properties = (
          event as {
            properties?: {
              info?: { scope?: { id?: string; directory?: string } }
              navEntry?: NavEntry
            }
          }
        )?.properties
        const info = properties?.info
        const scope = info?.scope
        if (!scope) return

        // Instant in-place projection: update any already-loaded nav entry for
        // this session immediately (title/pin/activity/archive), so the sidebar
        // doesn't lag the debounced refetch. The refetch below still runs as the
        // authority for ordering, new entries, and project aggregates.
        const navUpdate = navUpdateFromSession(info as Parameters<typeof navUpdateFromSession>[0], properties?.navEntry)
        const githubResult = applySessionToNavList(githubEntries, navUpdate)
        const githubAffected = properties?.navEntry?.category === "github" || githubResult.applied
        {
          const recentResult = applySessionToNavList(recentEntries, navUpdate)
          if (recentResult.applied) setRecentEntries(recentResult.list)
          if (githubResult.applied) setGitHubEntries(githubResult.list)
          const dir = scope.directory
          if (dir && navEntries[dir]) {
            const scopeResult = applySessionToNavList(navEntries[dir], navUpdate)
            if (scopeResult.applied) setNavEntries(dir, scopeResult.list)
          }
          for (const category of ROOT_NAV_SECTION_KEYS) {
            if (!rootNavStore[category]) continue
            const rootResult = applySessionToNavList(rootNavStore[category], navUpdate)
            if (rootResult.applied) setRootNavStore(category, rootResult.list)
          }
        }

        const recentPending = navRefreshTimers.get("__recent__")
        if (recentPending) clearTimeout(recentPending)
        navRefreshTimers.set(
          "__recent__",
          setTimeout(() => {
            navRefreshTimers.delete("__recent__")
            refreshGlobalRecent()
          }, NAV_REFRESH_DEBOUNCE_MS),
        )
        if (githubConfigured() && githubAffected) {
          const githubPending = navRefreshTimers.get("__github__")
          if (githubPending) clearTimeout(githubPending)
          navRefreshTimers.set(
            "__github__",
            setTimeout(() => {
              navRefreshTimers.delete("__github__")
              refreshGitHubSection()
            }, NAV_REFRESH_DEBOUNCE_MS),
          )
        }
        if (scope.id === "home") {
          for (const category of ROOT_NAV_SECTION_KEYS) {
            if (!rootNavStore[category]) continue
            const pending = navRefreshTimers.get(`__root_${category}`)
            if (pending) clearTimeout(pending)
            navRefreshTimers.set(
              `__root_${category}`,
              setTimeout(() => {
                navRefreshTimers.delete(`__root_${category}`)
                refreshRootNavSection(category)
              }, NAV_REFRESH_DEBOUNCE_MS),
            )
          }
          return
        }
        const dir = scope.directory
        if (!dir || !navEntries[dir]) return
        const pending = navRefreshTimers.get(dir)
        if (pending) clearTimeout(pending)
        navRefreshTimers.set(
          dir,
          setTimeout(() => {
            navRefreshTimers.delete(dir)
            refreshScopeNav(dir)
          }, NAV_REFRESH_DEBOUNCE_MS),
        )
      })
      onCleanup(unsub)
    })

    // --- Scope enrichment / color ---

    const usedColors = new Set<AvatarColorKey>()

    function scopeKeyForSession(session: Session): string {
      return session.scope.type === "home" || session.scope.id === HOME_SCOPE_KEY
        ? HOME_SCOPE_KEY
        : (session.scope.directory ?? session.scope.worktree ?? session.scope.id)
    }

    function scopeRequest(scopeKey: string) {
      return scopeKey === HOME_SCOPE_KEY ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }
    }

    function pickAvailableColor(): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !usedColors.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const childState = globalSync.peekScopeState(project.worktree)
      const scopeID = childState?.[0].scopeID
      const metadata = scopeID
        ? globalSync.data.scope.find((x) => x.id === scopeID)
        : globalSync.data.scope.find((x) => x.worktree === project.worktree)
      return [
        {
          ...(metadata ?? {}),
          ...project,
          icon: { url: metadata?.icon?.url, color: metadata?.icon?.color },
        },
      ]
    }

    function colorize(scope: LocalScope) {
      if (scope.icon?.color) return scope
      const color = pickAvailableColor()
      usedColors.add(color)
      scope.icon = { ...scope.icon, color }
      if (scope.id) {
        globalSdk.client.scope.update({ path_scopeID: scope.id, icon: { color } })
      }
      return scope
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const scope of globalSync.data.scope) {
        const sandboxes = scope.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, scope.worktree)
        }
      }
      return map
    })

    createEffect(() => {
      const map = roots()
      if (map.size === 0) return

      const projects = server.scopes.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = map.get(project.worktree)
          if (!root) continue

          server.scopes.close(project.worktree)

          if (!seen.has(root)) {
            server.scopes.open(root)
            seen.add(root)
          }

          if (project.expanded) server.scopes.expand(root)
        }
      })
    })

    // Supplemental project scopes: server-side projects that are NOT in the
    // local server.scopes store. These are shown so the sidebar reflects all
    // projects (not just manually-opened ones), but their expand state lives
    // in-memory (not persisted) and their sessions load lazily via an
    // explicit "Load sessions" action rather than auto-loading on expand.
    // This keeps initial load light even when the server has dozens of
    // projects.
    const [supplementalExpanded, setSupplementalExpanded] = createSignal<Set<string>>(new Set())

    function toggleSupplementalExpand(directory: string) {
      setSupplementalExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(directory)) next.delete(directory)
        else next.add(directory)
        return next
      })
    }
    const enriched = createMemo(() => server.scopes.list().flatMap(enrich))

    const list = createMemo(() => {
      // Locally-tracked scopes (user-opened, persisted in localStorage).
      const local = enriched().flatMap(colorize)
      const index = scopeIndex()
      const managedScopeIDs = new Set(
        channelProjection().channelAccounts.flatMap((account) => account.projects.map((p) => p.scopeID)),
      )
      if (index.length === 0) return local.filter((s) => !s.id || !managedScopeIDs.has(s.id))

      // Supplement server-side projects that are NOT locally tracked, so the
      // sidebar reflects all projects (not just manually-opened ones). These
      // use a separate in-memory expanded set (not persisted) and load their
      // sessions lazily via an explicit "Load sessions" action rather than
      // auto-loading on expand — keeping initial load light even when the
      // server has dozens of projects.
      const seenDirectories = new Set(local.map((s) => s.worktree))
      const seenIDs = new Set(local.map((s) => s.id).filter(Boolean))
      const expandedSet = supplementalExpanded()
      const supplemented: LocalScope[] = []
      for (const entry of index) {
        if (entry.scopeType !== "project") continue
        if (managedScopeIDs.has(entry.scopeID)) continue
        if (entry.directory && seenDirectories.has(entry.directory)) continue
        if (entry.scopeID && seenIDs.has(entry.scopeID)) continue
        const metadata = globalSync.data.scope.find((s) => s.id === entry.scopeID || s.worktree === entry.directory)
        supplemented.push({
          ...(metadata ?? {}),
          id: entry.scopeID,
          worktree: entry.directory,
          expanded: expandedSet.has(entry.directory),
          icon: { url: entry.icon?.url ?? metadata?.icon?.url, color: entry.icon?.color ?? metadata?.icon?.color },
        })
      }

      const raw = [...local.filter((s) => !s.id || !managedScopeIDs.has(s.id)), ...supplemented.flatMap(colorize)]

      // Stable sort: pinned projects first (most-recently-pinned on top),
      // then by creation time ascending (oldest first), with directory as
      // tiebreaker. This keeps the project list predictably stable — session
      // activity no longer reorders projects.
      return raw.toSorted((a, b) => {
        const aPin = (a as { pinned?: number }).pinned ?? 0
        const bPin = (b as { pinned?: number }).pinned ?? 0
        if (aPin && !bPin) return -1
        if (!aPin && bPin) return 1
        if (aPin && bPin) return bPin - aPin
        const aCreated = (a as { time?: { created?: number } }).time?.created ?? 0
        const bCreated = (b as { time?: { created?: number } }).time?.created ?? 0
        if (aCreated !== bCreated) return bCreated - aCreated
        if (aCreated !== bCreated) return aCreated - bCreated
        return a.worktree.localeCompare(b.worktree)
      })
    })

    // Whether a project is supplemental (not locally tracked). Supplemental
    // projects manage expand state in-memory and load sessions lazily.
    function isSupplementalScope(scope: { worktree: string }): boolean {
      return !server.scopes.list().some((s) => s.worktree === scope.worktree)
    }

    onMount(() => {
      void loadGitHubConfiguration()
      loadScopeIndex().then(() => {
        loadGlobalRecent()
        for (const category of ROOT_NAV_SECTION_KEYS) {
          loadRootNavSection(category)
        }
        const projects = list()
        const loaded = new Set<string>()
        for (const project of projects) {
          if (project.expanded) {
            loadScopeNav(project.worktree)
            loaded.add(project.worktree)
          }
        }
        const scopeMetadata = new Map(globalSync.data.scope.map((scope) => [scope.id, scope]))
        let count = 0
        for (const entry of scopeIndex()) {
          if (count >= 3) break
          if (entry.scopeType !== "project") continue
          const metadata = scopeMetadata.get(entry.scopeID)
          const dir = metadata?.worktree ?? entry.directory
          const project = projects.find((candidate) => candidate.worktree === dir || candidate.id === entry.scopeID)
          const worktree = project?.worktree ?? dir
          if (worktree && !loaded.has(worktree)) {
            loadScopeNav(worktree)
            loaded.add(worktree)
            count++
          }
        }
      })
    })

    function sortSessions(a: Session, b: Session) {
      const aPinned = a.pinned && a.pinned > 0
      const bPinned = b.pinned && b.pinned > 0
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      if (aPinned && bPinned) return b.pinned! - a.pinned!
      return (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)
    }

    function projectSessions(scope: LocalScope | undefined): Session[] {
      if (!scope) return []
      const dirs = [scope.worktree, ...(scope.sandboxes ?? [])]
      const stores = dirs
        .map((dir) => globalSync.peekScopeState(dir)?.[0])
        .filter((store): store is NonNullable<typeof store> => !!store)
      const byID = new Map<string, Session>()
      for (const session of stores.flatMap((s) =>
        s.session.filter((session) => session.scope.directory === s.path.directory),
      )) {
        if (!session.parentID) byID.set(session.id, session)
      }
      return [...byID.values()].toSorted(sortSessions)
    }

    function projectNavEntries(scope: LocalScope | undefined): NavEntry[] {
      if (!scope) return []
      const entry = navEntries[scope.worktree]
      if (!entry) return []
      return orderNavEntries(entry.items)
    }

    function recentNavEntries(): NavEntry[] {
      return orderNavEntries(recentEntries.items)
    }

    function hasMoreRecent(): boolean {
      return recentEntries.nextCursor != null
    }

    // Nav entries are populated via loadScopeNav / loadGlobalRecent / loadRootNavSection.
    // Session events trigger depth-preserving refreshes via refreshScopeNav / etc.

    function childStoreForScope(scope: LocalScope | undefined) {
      if (!scope) return undefined
      return globalSync.peekScopeState(scope.worktree)?.[0]
    }

    type PrefetchQueue = {
      inflight: Set<string>
      pending: string[]
      pendingSet: Set<string>
      running: number
    }

    const prefetchChunk = 200
    const prefetchConcurrency = 1
    const prefetchPendingLimit = 6
    const prefetchToken = { value: 0 }
    const prefetchQueues = new Map<string, PrefetchQueue>()

    const queueFor = (directory: string) => {
      const existing = prefetchQueues.get(directory)
      if (existing) return existing
      const created: PrefetchQueue = {
        inflight: new Set(),
        pending: [],
        pendingSet: new Set(),
        running: 0,
      }
      prefetchQueues.set(directory, created)
      return created
    }

    const prefetchMessages = (scopeKey: string, sessionID: string, token: number) => {
      const [, setChildStore] = globalSync.ensureScopeState(scopeKey)
      const request = globalSync.captureResourceRequest(scopeKey, sessionID, "message")
      const revision = globalSync.beginContextProjection(scopeKey, sessionID)
      return retry(() =>
        globalSdk.client.session.messagePage({
          ...scopeRequest(scopeKey),
          sessionID,
          limit: prefetchChunk,
        }),
      )
        .then((response) => {
          if (prefetchToken.value !== token || !response.data) return
          globalSync.applyResourceResponse(scopeKey, sessionID, "message", request, response.response?.headers, () => {
            const plan = planMessagePageApply({ page: response.data! })
            batch(() => {
              setChildStore("message", sessionID, reconcile(plan.window.messages, { key: "id" }))
              setChildStore("messageWindow", sessionID, reconcile(plan.metadata))
              globalSync.setLatestContextMessage(scopeKey, sessionID, plan.latestContextMessage, revision)
              for (const [messageID, parts] of Object.entries(plan.parts)) {
                setChildStore("part", messageID, reconcile(parts, { key: "id" }))
              }
            })
            globalSync.touchMessageBucket(scopeKey, sessionID)
          })
        })
        .catch(() => undefined)
    }

    const pumpPrefetch = (scopeKey: string) => {
      const q = queueFor(scopeKey)
      if (q.running >= prefetchConcurrency) return
      const sessionID = q.pending.shift()
      if (!sessionID) return
      q.pendingSet.delete(sessionID)
      q.inflight.add(sessionID)
      q.running += 1
      const token = prefetchToken.value
      void prefetchMessages(scopeKey, sessionID, token).finally(() => {
        q.running -= 1
        q.inflight.delete(sessionID)
        pumpPrefetch(scopeKey)
      })
    }

    function prefetchSession(session: Session, priority: "high" | "low" = "low") {
      const scopeKey = scopeKeyForSession(session)
      if (!scopeKey) return
      const [childStore] = globalSync.ensureScopeState(scopeKey)
      if (childStore.message[session.id] !== undefined) return
      const q = queueFor(scopeKey)
      if (q.inflight.has(session.id)) return
      if (q.pendingSet.has(session.id)) return
      if (priority === "high") q.pending.unshift(session.id)
      if (priority !== "high") q.pending.push(session.id)
      q.pendingSet.add(session.id)
      while (q.pending.length > prefetchPendingLimit) {
        const dropped = q.pending.pop()
        if (!dropped) continue
        q.pendingSet.delete(dropped)
      }
      pumpPrefetch(scopeKey)
    }

    function resetPrefetch() {
      prefetchToken.value += 1
      for (const q of prefetchQueues.values()) {
        q.pending.length = 0
        q.pendingSet.clear()
      }
    }

    function setNavEntryCompletionNotice(
      scopeKey: string,
      sessionID: string,
      completionNotice: NavEntry["completionNotice"],
    ) {
      const updateEntry = (entry: NavEntry) => (entry.id === sessionID ? { ...entry, completionNotice } : entry)
      const projectEntry = navEntries[scopeKey]
      if (projectEntry) {
        setNavEntries(scopeKey, "items", (items) => items.map(updateEntry) as NavEntry[])
      }
      setRecentEntries("items", (items) => items.map(updateEntry) as NavEntry[])
      setGitHubEntries("items", (items) => items.map(updateEntry) as NavEntry[])
      for (const category of ROOT_NAV_SECTION_KEYS) {
        setRootNavStore(category, "items", (items) => items.map(updateEntry) as NavEntry[])
      }
    }

    function navEntryForSession(scopeKey: string, sessionID: string): NavEntry | undefined {
      return (
        navEntries[scopeKey]?.items.find((entry) => entry.id === sessionID) ??
        recentEntries.items.find((entry) => entry.id === sessionID) ??
        githubEntries.items.find((entry) => entry.id === sessionID) ??
        ROOT_NAV_SECTION_KEYS.flatMap((category) => rootNavStore[category].items).find(
          (entry) => entry.id === sessionID,
        )
      )
    }

    async function clearCompletionNotice(directory: string, sessionID: string) {
      const entry = navEntryForSession(directory, sessionID)
      if (!entry?.completionNotice.unread) return
      setNavEntryCompletionNotice(directory, sessionID, { unread: false, unreadCount: 0 })
      try {
        await globalSdk.client.session.update({
          ...scopeRequest(directory),
          sessionID,
          completionNotice: { unread: false },
        })
      } catch (err) {
        console.warn("Failed to clear session completion notice", err)
        if (entry) setNavEntryCompletionNotice(directory, sessionID, entry.completionNotice)
      }
    }

    async function archiveSession(session: Session) {
      const scopeKey = scopeKeyForSession(session)
      const [childStore, setChildStore] = globalSync.ensureScopeState(scopeKey)
      const sessions = childStore.session ?? []
      const index = sessions.findIndex((s) => s.id === session.id)
      const nextSession = sessions[index + 1] ?? sessions[index - 1]

      await globalSdk.client.session.update({
        ...scopeRequest(scopeKey),
        sessionID: session.id,
        time: { archived: Date.now() },
      })
      setChildStore(
        produce((draft) => {
          const index = findSessionIndex(draft.session, session.id)
          if (index !== -1) draft.session.splice(index, 1)
        }),
      )
      const existing = navEntries[scopeKey]
      if (existing) {
        setNavEntries(scopeKey, {
          ...existing,
          items: existing.items.filter((e) => e.id !== session.id),
          total: Math.max(0, existing.total - 1),
        })
      }
      return nextSession
    }

    async function pinSession(session: Session, pinned: boolean) {
      const scopeKey = scopeKeyForSession(session)
      const [, setChildStore] = globalSync.ensureScopeState(scopeKey)
      const value = pinned ? Date.now() : 0
      setChildStore(
        produce((draft) => {
          const index = findSessionIndex(draft.session, session.id)
          if (index !== -1) draft.session[index].pinned = value
        }),
      )
      const existing = navEntries[scopeKey]
      if (existing) {
        setNavEntries(
          scopeKey,
          "items",
          (items) => items.map((e) => (e.id === session.id ? { ...e, pinned: value } : e)) as NavEntry[],
        )
      }
      await globalSdk.client.session.update({
        ...scopeRequest(scopeKey),
        sessionID: session.id,
        pinned: value,
      })
    }

    const isDesktop = createMediaQuery("(min-width: 768px)")

    return {
      channelProjection: () => channelProjection(),
      ready,
      isDesktop,
      nav: {
        projectSessions,
        projectNavEntries,
        rootNavEntries: rootNavEntriesFor,
        hasMoreRootNavSection,
        loadMoreRootNavSection,
        recentEntries: recentNavEntries,
        hasMoreRecent,
        loadMoreNav,
        githubConfigured,
        githubEntries: githubNavEntries,
        hasMoreGitHub,
        loadMoreGitHub,
        childStoreForScope,
        prefetchSession,
        resetPrefetch,
        archiveSession,
        pinSession,
        clearCompletionNotice,
        loadScopeNav: (directory: string) => loadScopeNav(directory),
        navEntries: () => navEntries,
        scopeIndexLoaded,
      },
      scopes: {
        list,
        isSupplemental: isSupplementalScope,
        toggleSupplementalExpand,
        async open(directory: string) {
          const root = roots().get(directory) ?? directory
          if (server.scopes.list().find((x) => x.worktree === root)) return
          server.scopes.open(root)
          await loadScopeNav(root)
          loadScopeIndex()
        },
        close(directory: string) {
          server.scopes.close(directory)
        },
        expand(directory: string) {
          server.scopes.expand(directory)
          if (!navEntries[directory]) {
            loadScopeNav(directory)
          }
        },
        collapse(directory: string) {
          server.scopes.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.scopes.move(directory, toIndex)
        },
        async pinScope(scope: { worktree: string; pinned?: number; id?: string }) {
          const isPinned = (scope.pinned ?? 0) > 0
          const value = isPinned ? 0 : Date.now()
          server.scopes.pin(scope.worktree, value)
          if (scope.id) {
            try {
              await globalSdk.client.scope.update({ path_scopeID: scope.id, pinned: value })
            } catch (err) {
              console.warn("Failed to persist scope pin state", err)
            }
          }
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
      },
      review: {
        diffStyle: createMemo(() => (store.review?.diffStyle ?? "split") as ReviewDiffStyle),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      surface(sessionKey: string, surface: WorkbenchPanelSurface) {
        touch(sessionKey)
        const current = () => store.workbenchSurfaces[sessionKey]?.[surface] ?? {}
        const sizeDefault = () =>
          surface === "side" ? computeDefaultWorkspaceWidth(window.innerWidth) : BOTTOM_SPACE_DEFAULT_HEIGHT

        function ensureSurface() {
          const session = store.workbenchSurfaces[sessionKey]
          if (!session) {
            setStore("workbenchSurfaces", sessionKey, {})
          }
          if (!store.workbenchSurfaces[sessionKey]?.[surface]) {
            setStore("workbenchSurfaces", sessionKey, surface, {
              opened: false,
              tabs: [],
              active: undefined,
            })
          }
        }

        return {
          opened: () => current().opened === true,
          active: () => current().active,
          tabs: () => current().tabs ?? [],
          activeTab: () => (current().tabs ?? []).find((tab) => tab.id === current().active),
          size: () => {
            const state = current()
            return state.resized && typeof state.size === "number" ? state.size : sizeDefault()
          },
          open() {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "opened", true)
          },
          close() {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "opened", false)
          },
          toggle() {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "opened", (x) => !(x ?? false))
          },
          setActive(tab: string | undefined) {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "active", tab)
          },
          setTabs(tabs: WorkbenchPanelTab[]) {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "tabs", tabs)
          },
          setSize(size: number) {
            ensureSurface()
            setStore("workbenchSurfaces", sessionKey, surface, "size", size)
            setStore("workbenchSurfaces", sessionKey, surface, "resized", true)
          },
        }
      },
      transferWorkbenchState(from: string, to: string) {
        if (from === to) return
        const source = store.workbenchSurfaces[from]
        if (!source) return
        const target = store.workbenchSurfaces[to]
        const targetHasTabs = [target?.side, target?.bottom].some((surface) => (surface?.tabs?.length ?? 0) > 0)
        if (targetHasTabs) return
        setStore(
          produce((draft) => {
            draft.workbenchSurfaces[to] = source
            delete draft.workbenchSurfaces[from]
          }),
        )
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      rightSidebar: {
        opened: createMemo(() => store.rightSidebar?.opened ?? false),
        show() {
          setStore("rightSidebar", "opened", true)
        },
        hide() {
          setStore("rightSidebar", "opened", false)
        },
        toggle() {
          setStore("rightSidebar", "opened", (x) => !x)
        },
      },
      view(sessionKey: string) {
        touch(sessionKey)
        scroll.seed(sessionKey)
        const s = createMemo(() => store.sessionView[sessionKey] ?? { scroll: {} })
        return {
          scroll(tab: string) {
            return scroll.scroll(sessionKey, tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(sessionKey, tab, pos)
          },
          review: {
            open: createMemo(() => s().reviewOpen),
            setOpen(open: string[]) {
              const current = store.sessionView[sessionKey]
              if (!current) {
                setStore("sessionView", sessionKey, { scroll: {}, reviewOpen: open })
                return
              }

              if (same(current.reviewOpen, open)) return
              setStore("sessionView", sessionKey, "reviewOpen", open)
            },
          },
        }
      },
    }
  },
})
