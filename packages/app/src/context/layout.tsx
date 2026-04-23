import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount } from "solid-js"
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
import { reconcile } from "solid-js/store"

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

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const server = useServer()
    const [store, setStore, _, ready] = persisted(
      Persist.global("layout", ["layout.v6"]),
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

    const usedColors = new Set<AvatarColorKey>()

    function pickAvailableColor(): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !usedColors.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = globalSync.child(project.worktree)
      const scopeID = childStore.scopeID
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
        globalSdk.client.scope.update({ scopeID: scope.id, icon: { color } })
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

    const enriched = createMemo(() => server.scopes.list().flatMap(enrich))
    const list = createMemo(() => enriched().flatMap(colorize))

    onMount(() => {
      Promise.all(
        server.scopes.list().map((project) => {
          return globalSync.scope.loadSessions(project.worktree)
        }),
      )
    })

    // Session management: sorting, prefetching, archiving, pinning
    function sortSessions(a: Session, b: Session) {
      const aPinned = a.pinned && a.pinned > 0
      const bPinned = b.pinned && b.pinned > 0
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      if (aPinned && bPinned) return b.pinned! - a.pinned!
      return 0
    }

    function projectSessions(scope: LocalScope | undefined) {
      if (!scope) return []
      const dirs = [scope.worktree, ...(scope.sandboxes ?? [])]
      const stores = dirs.map((dir) => globalSync.child(dir)[0])
      const sessions = stores
        .flatMap((s) => s.session.filter((session) => session.scope.directory === s.path.directory))
        .toSorted(sortSessions)
      return sessions.filter((s) => !s.parentID)
    }

    function projectSessionTotal(scope: LocalScope | undefined) {
      if (!scope) return 0
      const dirs = [scope.worktree, ...(scope.sandboxes ?? [])]
      return dirs.reduce((sum, dir) => {
        const [store] = globalSync.child(dir)
        return sum + (store.sessionTotal ?? 0)
      }, 0)
    }

    function childStoreForScope(scope: LocalScope | undefined) {
      if (!scope) return undefined
      return globalSync.child(scope.worktree)[0]
    }

    type ChildInfo = {
      count: number
      sessions: Session[]
      running: number
    }

    function childInfoForScope(scope: LocalScope | undefined): Record<string, ChildInfo> {
      if (!scope) return {}
      const store = childStoreForScope(scope)
      const dirs = [scope.worktree, ...(scope.sandboxes ?? [])]
      const stores = dirs.map((dir) => globalSync.child(dir)[0])
      const all = stores.flatMap((s) => s.session.filter((session) => session.scope.directory === s.path.directory))
      const result: Record<string, ChildInfo> = {}
      for (const session of all) {
        if (!session.parentID) continue
        if (!result[session.parentID]) result[session.parentID] = { count: 0, sessions: [], running: 0 }
        const info = result[session.parentID]
        info.count++
        info.sessions.push(session)
        if (store) {
          const status = store.session_status[session.id]
          if (status?.type === "busy" || status?.type === "retry") info.running++
        }
      }
      // Sort children by updated desc within each parent
      for (const info of Object.values(result)) {
        info.sessions.sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      }
      return result
    }

    // Prefetch queue system
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

    const prefetchMessages = (directory: string, sessionID: string, token: number) => {
      const [, setChildStore] = globalSync.child(directory)
      return retry(() => globalSdk.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
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

    const pumpPrefetch = (directory: string) => {
      const q = queueFor(directory)
      if (q.running >= prefetchConcurrency) return
      const sessionID = q.pending.shift()
      if (!sessionID) return
      q.pendingSet.delete(sessionID)
      q.inflight.add(sessionID)
      q.running += 1
      const token = prefetchToken.value
      void prefetchMessages(directory, sessionID, token).finally(() => {
        q.running -= 1
        q.inflight.delete(sessionID)
        pumpPrefetch(directory)
      })
    }

    function prefetchSession(session: Session, priority: "high" | "low" = "low") {
      const directory = session.scope.directory
      if (!directory) return
      const [childStore] = globalSync.child(directory)
      if (childStore.message[session.id] !== undefined) return
      const q = queueFor(directory)
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
      pumpPrefetch(directory)
    }

    function resetPrefetch() {
      prefetchToken.value += 1
      for (const q of prefetchQueues.values()) {
        q.pending.length = 0
        q.pendingSet.clear()
      }
    }

    async function archiveSession(session: Session) {
      const [childStore, setChildStore] = globalSync.child(session.scope.directory!)
      const sessions = childStore.session ?? []
      const index = sessions.findIndex((s) => s.id === session.id)
      const nextSession = sessions[index + 1] ?? sessions[index - 1]

      await globalSdk.client.session.update({
        directory: session.scope.directory,
        sessionID: session.id,
        time: { archived: Date.now() },
      })
      setChildStore(
        produce((draft) => {
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session.splice(match.index, 1)
        }),
      )
      return nextSession
    }

    async function pinSession(session: Session, pinned: boolean) {
      const [, setChildStore] = globalSync.child(session.scope.directory!)
      const value = pinned ? Date.now() : 0
      setChildStore(
        produce((draft) => {
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session[match.index].pinned = value
        }),
      )
      await globalSdk.client.session.update({
        directory: session.scope.directory,
        sessionID: session.id,
        pinned: value,
      })
    }

    const isDesktop = createMediaQuery("(min-width: 768px)")

    return {
      ready,
      isDesktop,
      nav: {
        sortSessions,
        projectSessions,
        projectSessionTotal,
        childStoreForScope,
        childInfoForScope,
        prefetchSession,
        resetPrefetch,
        archiveSession,
        pinSession,
      },
      scopes: {
        list,
        open(directory: string) {
          const root = roots().get(directory) ?? directory
          if (server.scopes.list().find((x) => x.worktree === root)) return
          globalSync.scope.loadSessions(root)
          server.scopes.open(root)
        },
        close(directory: string) {
          server.scopes.close(directory)
        },
        expand(directory: string) {
          server.scopes.expand(directory)
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
        // TODO: redesign sidebar — disabled for now
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
