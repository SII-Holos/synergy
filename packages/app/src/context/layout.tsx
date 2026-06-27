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
import { reconcile } from "solid-js/store"
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

export type LocalScope = Partial<Scope> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export const SESSION_PAGE_SIZE = 20

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
type NavListState = { items: NavEntry[]; nextCursor: NavCursor | null; total: number }
function emptyNavList(): NavListState {
  return { items: [], nextCursor: null, total: 0 }
}
const NAV_FIRST_PAGE_LIMIT = 10
const RECENT_LIMIT = 10

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const server = useServer()
    const [store, setStore, _, ready] = persisted(
      Persist.global("layout", ["layout.v8", "layout.v9"]),
      createStore({
        sidebar: {
          opened: false,
          width: 280,
        },
        terminal: {
          opened: false,
          height: 280,
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
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        workspaceSessions: {} as Record<string, { opened: boolean; active: string | null; width?: number; resized?: boolean }>,
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
      for (const key of Object.keys(store.workspaceSessions)) keys.add(key)
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
            delete draft.workspaceSessions[key]
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
          ]
          setNavEntries(directory, { items: merged, nextCursor: data.nextCursor, total: data.total })
        } else {
          setNavEntries(directory, { items: data.items as NavEntry[], nextCursor: data.nextCursor, total: data.total })
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
          ]
          setRootNavStore(category, { items: merged, nextCursor: data.nextCursor, total: data.total })
        } else {
          setRootNavStore(category, {
            items: data.items as NavEntry[],
            nextCursor: data.nextCursor,
            total: data.total,
          })
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
          const merged = [...existing, ...data.items.filter((e) => !existing.some((x) => x.id === e.id))]
          setRecentEntries({ items: merged, nextCursor: data.nextCursor, total: data.total })
        } else {
          setRecentEntries({ items: data.items as NavEntry[], nextCursor: data.nextCursor, total: data.total })
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
        setRecentEntries({ items: data.items as NavEntry[], nextCursor: data.nextCursor, total: data.total })
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
          limit: Math.max(ROOT_NAV_SECTION_LIMIT, existing?.items.length ?? 0),
        })
        if (!res.data) return
        const data = res.data
        setRootNavStore(category, {
          items: data.items as NavEntry[],
          nextCursor: data.nextCursor,
          total: data.total,
        })
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
        setNavEntries(directory, { items: data.items as NavEntry[], nextCursor: data.nextCursor, total: data.total })
      } finally {
        navPending.delete(key)
      }
    }

    function rootNavEntriesFor(category: RootNavSectionKey): NavEntry[] {
      const entry = rootNavStore[category]
      if (!entry) return []
      return entry.items.toSorted((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        if (a.pinned && b.pinned) return b.pinned - a.pinned
        return b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id)
      })
    }

    function hasMoreRootNavSection(category: RootNavSectionKey): boolean {
      return rootNavStore[category]?.nextCursor != null
    }

    // --- Nav event refresh ---
    // On session.updated, refresh nav lists preserving current depth.
    const navRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const NAV_REFRESH_DEBOUNCE_MS = 300

    onMount(() => {
      const unsub = globalSdk.event.listen((e) => {
        if ((e.details as { type?: string })?.type !== "session.updated") return
        const info = (e.details as { properties?: { info?: { scope?: { id?: string; directory?: string } } } })
          ?.properties?.info
        const scope = info?.scope
        if (!scope) return
        const recentPending = navRefreshTimers.get("__recent__")
        if (recentPending) clearTimeout(recentPending)
        navRefreshTimers.set(
          "__recent__",
          setTimeout(() => {
            navRefreshTimers.delete("__recent__")
            refreshGlobalRecent()
          }, NAV_REFRESH_DEBOUNCE_MS),
        )
        const scopeIndexPending = navRefreshTimers.get("__scopeIndex__")
        if (scopeIndexPending) clearTimeout(scopeIndexPending)
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
      if (index.length === 0) return local

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

      const raw = [...local, ...supplemented.flatMap(colorize)]

      const order = new Map(index.map((e, i) => [e.scopeID, i]))
      return raw.toSorted((a, b) => {
        const aIdx = order.get(a.id ?? "")
        const bIdx = order.get(b.id ?? "")
        if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx
        if (aIdx !== undefined) return -1
        if (bIdx !== undefined) return 1
        return 0
      })
    })

    // Whether a project is supplemental (not locally tracked). Supplemental
    // projects manage expand state in-memory and load sessions lazily.
    function isSupplementalScope(scope: { worktree: string }): boolean {
      return !server.scopes.list().some((s) => s.worktree === scope.worktree)
    }

    onMount(() => {
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
      return entry.items.toSorted((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        if (a.pinned && b.pinned) return b.pinned - a.pinned
        return b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id)
      })
    }

    function recentNavEntries(): NavEntry[] {
      return recentEntries.items.toSorted((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        if (a.pinned && b.pinned) return b.pinned - a.pinned
        return b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id)
      })
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
      return retry(() =>
        globalSdk.client.session.messages({ ...scopeRequest(scopeKey), sessionID, limit: prefetchChunk }),
      )
        .then((messages) => {
          if (prefetchToken.value !== token) return
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          const next = items
            .map((x) => x.info)
            .filter((m) => !!m?.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
          batch(() => {
            setChildStore("message", sessionID, reconcile(next, { key: "id" }))
            for (const message of items) {
              setChildStore(
                "part",
                message.info.id,
                reconcile(
                  message.parts
                    .filter((p) => !!p?.id)
                    .slice()
                    .sort((a, b) => a.id.localeCompare(b.id)),
                  { key: "id" },
                ),
              )
            }
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
      terminal: {
        opened: createMemo(() => store.terminal.opened),
        open() {
          setStore("terminal", "opened", true)
        },
        close() {
          setStore("terminal", "opened", false)
        },
        toggle() {
          setStore("terminal", "opened", (x) => !x)
        },
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
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
      workspace(sessionKey: string) {
        touch(sessionKey)
        const ws = createMemo(() => store.workspaceSessions[sessionKey] ?? { opened: false, active: null })
        return {
          opened: createMemo(() => ws().opened),
          active: createMemo(() => ws().active),
          width: createMemo(() => {
            const current = ws()
            return current.resized && typeof current.width === "number"
              ? current.width
              : computeDefaultWorkspaceWidth(window.innerWidth)
          }),
          open() {
            setStore("workspaceSessions", sessionKey, {
              ...ws(),
              opened: true,
              active: ws().active ?? null,
            })
          },
          close() {
            setStore("workspaceSessions", sessionKey, "opened", false)
          },
          toggle() {
            setStore("workspaceSessions", sessionKey, "opened", (x) => !(x ?? false))
          },
          setActive(tool: string | null) {
            if (!store.workspaceSessions[sessionKey]) {
              setStore("workspaceSessions", sessionKey, {
                opened: false,
                active: tool,
              })
            } else {
              setStore("workspaceSessions", sessionKey, "active", tool)
            }
          },
          setWidth(width: number) {
            if (!store.workspaceSessions[sessionKey]) {
              setStore("workspaceSessions", sessionKey, { opened: false, active: null, width, resized: true })
            } else {
              setStore("workspaceSessions", sessionKey, "width", width)
              setStore("workspaceSessions", sessionKey, "resized", true)
            }
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
