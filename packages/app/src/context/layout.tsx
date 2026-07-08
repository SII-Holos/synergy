import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { createMediaQuery } from "@solid-primitives/media"
import { useGlobalSync } from "./global-sync"
import { useGlobalSDK } from "./global-sdk"
import { useServer } from "./server"
import { Scope, Session } from "@ericsanchezok/synergy-sdk"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { computeDefaultWorkspaceWidth } from "./workspace-layout"
import type { WorkbenchPanelSurface, WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import type { WorkbenchSurfaceState } from "./workbench-panels-model"
import { migrateWorkbenchLayout } from "./workbench-layout-migration"
import { reconcile } from "solid-js/store"
import { applySessionToNavList, mergeNavListByID, navUpdateFromSession, orderNavEntries } from "./layout-nav"
import { HOME_SCOPE_KEY } from "@/utils/scope"

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

type SessionTabs = {
  active?: string
  all: string[]
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

export type LocalScope = Partial<Scope> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export const SESSION_PAGE_SIZE = 20
const BOTTOM_SPACE_DEFAULT_HEIGHT = 280

// --- Nav v2 types (matches backend SessionNavEntry / ScopeNavEntry) ---

export interface NavEntry {
  id: string
  scopeID: string
  scopeType: "home" | "project"
  title: string
  category: "project" | "home" | "channel" | "background"
  lastActivityAt: number
  pinned: number
  archived: boolean
  parentID?: string
  endpointKind?: "channel"
  chatId?: string
  chatName?: string
  chatType?: string
  completionNotice: {
    unread: boolean
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
    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("layout", ["layout.v8", "layout.v9"]), migrate: migrateWorkbenchLayout },
      createStore({
        sidebar: {
          opened: false,
          width: 280,
        },
        review: {
          opened: true,
          diffStyle: "split" as ReviewDiffStyle,
        },
        session: {
          width: 600,
        },
        mobileSidebar: {
          opened: false,
        },
        rightSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
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
      for (const key of Object.keys(store.sessionTabs)) keys.add(key)
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
            delete draft.sessionTabs[key]
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
    const navPending = new Set<string>()
    const [scopeIndexLoaded, setScopeIndexLoaded] = createSignal(false)

    async function loadScopeIndex() {
      await globalSdk.client.scope.list()
      try {
        const res = await globalSdk.client.scope.index()
        if (res.data) {
          setScopeIndex(res.data as ScopeNavEntry[])
        }
      } catch (err) {
        console.warn("Failed to load scope index", err)
        // fall through; scope ordering remains localStorage-based
      } finally {
        setScopeIndexLoaded(true)
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

    async function refreshRootNavSection(category: RootNavSectionKey) {
      const key = `__refresh_root_${category}`
      if (navPending.has(key)) return
      navPending.add(key)
      try {
        const res = await globalSdk.client.session.index({
          scopeID: "home",
          category,
          parentOnly: "true",
          includeArchived: category === "channel" ? "true" : undefined,
          limit: Math.max(ROOT_NAV_SECTION_LIMIT, rootNavStore[category]?.items.length ?? 0),
        })
        if (!res.data) return
        const data = res.data
        setRootNavStore(
          category,
          mergeNavListByID(rootNavStore[category], {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          }),
        )
      } finally {
        navPending.delete(key)
      }
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const scope of scopeIndex()) {
        map.set(scope.worktree, scope.worktree)
        map.set(scope.scopeID, scope.worktree)
      }
      return map
    })

    const list = createMemo(() => {
      const serverScopes = server.scopes.list()
      return serverScopes.map((scope) => {
        const meta = (globalSync.data.scope ?? []).find((s) => s.id === scope.worktree)
        return {
          ...(meta ?? { worktree: scope.worktree }),
          workspace: scope.worktree,
          expanded: scope.expanded,
        } as LocalScope
      })
    })

    const navRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const NAV_REFRESH_DEBOUNCE_MS = 300

    createEffect(() => {
      const scopes = globalSync.data.scope
      for (const scope of scopes) {
        if (!scope.id) continue
        const worktree = scope.worktree
        if (!worktree) continue

        const pending = navRefreshTimers.get(worktree)
        if (pending) clearTimeout(pending)
        navRefreshTimers.set(
          worktree,
          setTimeout(() => {
            navRefreshTimers.delete(worktree)
            loadScopeNav(worktree)
          }, NAV_REFRESH_DEBOUNCE_MS),
        )

        const scopeMeta = server.scopes.list().find((s) => s.worktree === worktree)
        if (!scopeMeta) continue

        const pendingIndex = navRefreshTimers.get("__scopeIndex__")
        if (pendingIndex) clearTimeout(pendingIndex)
        navRefreshTimers.set(
          "__scopeIndex__",
          setTimeout(() => {
            navRefreshTimers.delete("__scopeIndex__")
            loadScopeIndex()
          }, NAV_REFRESH_DEBOUNCE_MS),
        )
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
        }
      }
    })

    createEffect(() => {
      const sessions = globalSync.data.session ?? []
      for (const session of sessions) {
        if (!session.id) continue
        if (session.parentID) continue
        const scopeKey = scopeKeyForSession(session)
        updateNavEntryFromSession(scopeKey, session)
      }
    })

    function scopeKeyForSession(session: Pick<Session, "scope">): string {
      const scope = session.scope as Scope
      return scope.directory ?? scope.name ?? scope.id
    }

    function scopeRequest(scopeKey: string) {
      const scope = globalSync.data.scope.find((s) => s.id === scopeKey) ?? { id: scopeKey }
      return {
        scopeID: scope.id,
      }
    }

    const projectSessions = createMemo(() => {
      const result = new Map<string, NavEntry[]>()
      for (const entry of Object.values(navEntries)) {
        for (const item of entry.items) {
          if (item.scopeType !== "project" || item.archived) continue
          const existing = result.get(item.scopeID)
          if (existing) existing.push(item)
          else result.set(item.scopeID, [item])
        }
      }
      for (const scope of scopeIndex()) {
        if (!result.has(scope.scopeID)) {
          result.set(scope.scopeID, [])
        }
      }
      for (const entries of result.values()) {
        entries.sort((a, b) => {
          if (a.pinned && b.pinned) return b.pinned - a.pinned
          if (a.pinned) return -1
          if (b.pinned) return 1
          return b.lastActivityAt - a.lastActivityAt
        })
      }
      return result
    })

    const projectNavEntries = createMemo(() => {
      return scopeIndex().map((scope) => {
        const sessions = projectSessions().get(scope.scopeID) ?? []
        return {
          ...scope,
          sessions,
          sessionCount: sessions.length,
        }
      })
    })

    const rootNavEntriesFor = createMemo(() => (category: RootNavSectionKey) => {
      const entries = rootNavStore[category].items
      return entries.slice().sort((a, b) => {
        if (a.pinned && b.pinned) return b.pinned - a.pinned
        if (a.pinned) return -1
        if (b.pinned) return 1
        return b.lastActivityAt - a.lastActivityAt
      })
    })

    const recentNavEntries = createMemo(() => {
      return recentEntries.items.slice().sort((a, b) => {
        if (a.pinned && b.pinned) return b.pinned - a.pinned
        if (a.pinned) return -1
        if (b.pinned) return 1
        return b.lastActivityAt - a.lastActivityAt
      })
    })

    function updateNavEntryFromSession(scopeKey: string, session: Pick<Session, "id" | "title" | "pinned" | "time">) {
      if (!session.id) return
      const result = Binary.search(navEntries[scopeKey]?.items ?? [], session.id, (e) => e.id)
      if (!result.found) return
      const entry: NavEntry | undefined = navEntries[scopeKey].items[result.index]
      if (!entry) return
      const next = {
        ...entry,
        title: session.title ?? entry.title,
        pinned: session.pinned ?? entry.pinned,
        lastActivityAt: session.time?.activity ?? entry.lastActivityAt,
      }
      if (same(entry, next)) return
      setNavEntries(scopeKey, "items", result.index, next)
      const recentResult = Binary.search(recentEntries.items, session.id, (e) => e.id)
      if (recentResult.found) {
        setRecentEntries("items", recentResult.index, next)
      }
      for (const category of ROOT_NAV_SECTION_KEYS) {
        const categoryResult = Binary.search(rootNavStore[category].items, session.id, (e) => e.id)
        if (categoryResult.found) {
          setRootNavStore(category, "items", categoryResult.index, next)
        }
      }
    }

    function setNavEntryCompletionUnread(directory: string, sessionID: string, unread: boolean) {
      const scopeKey = directory
      const updateEntry = (entry: NavEntry) =>
        entry.id === sessionID ? { ...entry, completionNotice: { unread } } : entry
      const projectEntry = navEntries[scopeKey]
      if (projectEntry) {
        setNavEntries(scopeKey, "items", (items) => items.map(updateEntry) as NavEntry[])
      }
      setRecentEntries("items", (items) => items.map(updateEntry) as NavEntry[])
      for (const category of ROOT_NAV_SECTION_KEYS) {
        setRootNavStore(category, "items", (items) => items.map(updateEntry) as NavEntry[])
      }
    }

    function navEntryForSession(scopeKey: string, sessionID: string): NavEntry | undefined {
      return (
        navEntries[scopeKey]?.items.find((entry) => entry.id === sessionID) ??
        recentEntries.items.find((entry) => entry.id === sessionID) ??
        ROOT_NAV_SECTION_KEYS.flatMap((category) => rootNavStore[category].items).find(
          (entry) => entry.id === sessionID,
        )
      )
    }

    async function clearCompletionNotice(directory: string, sessionID: string) {
      const entry = navEntryForSession(directory, sessionID)
      if (!entry?.completionNotice.unread) return
      setNavEntryCompletionUnread(directory, sessionID, false)
      try {
        await globalSdk.client.session.update({
          ...scopeRequest(directory),
          sessionID,
          completionNotice: { unread: false },
        })
      } catch (err) {
        console.warn("Failed to clear session completion notice", err)
        if (entry) setNavEntryCompletionUnread(directory, sessionID, true)
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
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session.splice(match.index, 1)
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
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session[match.index].pinned = value
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
          loadScopeIndex()
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
        opened: createMemo(() => false),
        diffStyle: createMemo(() => (store.review?.diffStyle ?? "split") as ReviewDiffStyle),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { opened: true, diffStyle })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
        open() {},
        close() {},
        toggle() {},
      },
      session: {
        width: createMemo(() => store.session?.width ?? 600),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      surface(sessionKey: string, surface: WorkbenchPanelSurface) {
        touch(sessionKey)
        const current = createMemo(() => store.workbenchSurfaces[sessionKey]?.[surface] ?? {})
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
          opened: createMemo(() => current().opened === true),
          active: createMemo(() => current().active),
          tabs: createMemo(() => current().tabs ?? []),
          activeTab: createMemo(() => (current().tabs ?? []).find((tab) => tab.id === current().active)),
          size: createMemo(() => {
            const state = current()
            return state.resized && typeof state.size === "number" ? state.size : sizeDefault()
          }),
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
      tabs(sessionKey: string) {
        touch(sessionKey)
        const tabs = createMemo(() => store.sessionTabs[sessionKey] ?? { all: [] })
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all),
          setActive(tab: string | undefined) {
            if (!store.sessionTabs[sessionKey]) {
              setStore("sessionTabs", sessionKey, { all: [], active: tab })
            } else {
              setStore("sessionTabs", sessionKey, "active", tab)
            }
          },
          setAll(all: string[]) {
            if (!store.sessionTabs[sessionKey]) {
              setStore("sessionTabs", sessionKey, { all, active: undefined })
            } else {
              setStore("sessionTabs", sessionKey, "all", all)
            }
          },
          async open(tab: string) {
            const current = store.sessionTabs[sessionKey] ?? { all: [] }

            if (tab === "review") {
              if (!store.sessionTabs[sessionKey]) {
                setStore("sessionTabs", sessionKey, { all: [], active: tab })
                return
              }
              setStore("sessionTabs", sessionKey, "active", tab)
              return
            }

            if (tab === "context") {
              const all = [tab, ...current.all.filter((x) => x !== tab)]
              if (!store.sessionTabs[sessionKey]) {
                setStore("sessionTabs", sessionKey, { all, active: tab })
                return
              }
              setStore("sessionTabs", sessionKey, "all", all)
              setStore("sessionTabs", sessionKey, "active", tab)
              return
            }

            if (!current.all.includes(tab)) {
              if (!store.sessionTabs[sessionKey]) {
                setStore("sessionTabs", sessionKey, { all: [tab], active: tab })
                return
              }
              setStore("sessionTabs", sessionKey, "all", [...current.all, tab])
              setStore("sessionTabs", sessionKey, "active", tab)
              return
            }

            if (!store.sessionTabs[sessionKey]) {
              setStore("sessionTabs", sessionKey, { all: current.all, active: tab })
              return
            }
            setStore("sessionTabs", sessionKey, "active", tab)
          },
          close(tab: string) {
            const current = store.sessionTabs[sessionKey]
            if (!current) return

            const all = current.all.filter((x) => x !== tab)
            batch(() => {
              setStore("sessionTabs", sessionKey, "all", all)
              if (current.active !== tab) return

              const index = current.all.findIndex((f) => f === tab)
              const next = all[index - 1] ?? all[0]
              setStore("sessionTabs", sessionKey, "active", next)
            })
          },
          move(tab: string, to: number) {
            const current = store.sessionTabs[sessionKey]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              sessionKey,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
