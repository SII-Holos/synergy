import { createStore } from "solid-js/store"
import { createEffect, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSDK, useRetainedGlobalSDK } from "./global-sdk"
import { usePlatform, type NotificationActivation } from "@/context/platform"
import { EventSessionError } from "@ericsanchezok/synergy-sdk"
import { makeAudioPlayer } from "@solid-primitives/audio"
import completionSound from "@ericsanchezok/synergy-ui/audio/staplebops-01.aac"
import errorSound from "@ericsanchezok/synergy-ui/audio/nope-03.aac"
import { Persist, persisted } from "@/utils/persist"
import {
  resolveNotificationEvent,
  resolveOrganizationNotice,
  type OrganizationNotificationOrigin,
  type ResolvedNotificationEvent,
} from "./notification-event"
import { useLingui } from "@lingui/solid"
import { messages as AP } from "@/locales/messages"
import { useOptionalSpace } from "./space"
import { spaceKey } from "./space-state"
import { organizationSpaceKey } from "../organization/connections"
import { assetPath } from "../utils/proxy"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { Event, Session } from "@ericsanchezok/synergy-sdk/client"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  organization?: OrganizationNotificationOrigin
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

export type Notification = TurnCompleteNotification | ErrorNotification

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function notificationState(key: string) {
  const [store, setStore, , ready] = persisted(
    Persist.connection(key, "notification"),
    createStore({ list: [] as Notification[] }),
  )
  let pruned = false
  createEffect(() => {
    if (!ready() || pruned) return
    pruned = true
    setStore("list", pruneNotifications(store.list))
  })
  return {
    store,
    setStore,
    ready,
    append(value: Notification) {
      setStore("list", (list) => pruneNotifications([...list, value]))
    },
  }
}

function lazyNotificationState(key: string) {
  const owner = getOwner()
  let state: ReturnType<typeof notificationState> | undefined
  let unreadable = false
  const read = () => {
    if (unreadable) return
    try {
      return (state ??= runWithOwner(owner, () => notificationState(key)))
    } catch {
      unreadable = true
      return
    }
  }
  return {
    ready: () => read()?.ready() ?? false,
    list: () => read()?.store.list ?? [],
    append(value: Notification) {
      read()?.append(value)
    },
    markViewed(predicate: (value: Notification) => boolean) {
      read()?.setStore("list", predicate, "viewed", true)
    },
  }
}

type PersonalEvent = Extract<Event, { type: "session.completion" | "session.error" }>
export const { use: useNotification, provider: NotificationProvider } = createSimpleContext({
  name: "Notification",
  gate: false,
  init: () => {
    let completionPlayer: ReturnType<typeof makeAudioPlayer> | undefined
    let errorPlayer: ReturnType<typeof makeAudioPlayer> | undefined
    try {
      completionPlayer = makeAudioPlayer(completionSound)
      errorPlayer = makeAudioPlayer(errorSound)
    } catch {}
    const retained = useRetainedGlobalSDK()
    const standalone = retained ? undefined : useGlobalSDK()
    const sdkSource = () => (retained ? retained.current() : standalone)
    const space = useOptionalSpace()
    const platform = usePlatform()
    const { _: translate } = useLingui()
    const [personal, setPersonal] = createSignal<ReturnType<typeof lazyNotificationState>>()
    const [organizations, setOrganizations] = createStore({ list: [] as Notification[] })
    const copy = () => ({
      responseReady: translate(AP.notification.responseReady),
      sessionError: translate(AP.notification.sessionError),
      errorFallback: translate(AP.notification.errorFallback),
    })
    function emit(
      value: ResolvedNotificationEvent,
      activation: NotificationActivation,
      background: boolean,
      tag: string,
    ) {
      try {
        void (value.type === "turn-complete" ? completionPlayer : errorPlayer)?.play().catch(() => {})
      } catch {}
      if (background)
        showToast({
          title: value.title,
          description: value.description,
          actions: [
            {
              label: translate(AP.notification.openSession),
              onClick: () => {
                if (activation.current()) activation.activate()
              },
            },
          ],
          key: tag,
        })
      try {
        void Promise.resolve(
          platform.notify(value.title, value.description, assetPath(value.href), tag, activation),
        ).catch(() => {})
      } catch {}
    }
    createEffect(() => {
      const source = sdkSource()
      if (!source) {
        setPersonal(undefined)
        return
      }
      const sdk = source
      const state = createRoot((dispose) => {
        const state = lazyNotificationState(sdk.cacheKey)
        const lifetime = new AbortController()
        const current = () => !lifetime.signal.aborted && sdkSource() === sdk
        const queue: Array<{ directory: string; event: PersonalEvent }> = []
        let processing = false
        async function drain() {
          if (processing) return
          processing = true
          try {
            while (current() && queue.length) {
              const input = queue.shift()!
              const { event, directory } = input
              const sessionID = event.properties.sessionID
              if (event.properties.source?.parentID || event.properties.source?.references["organization-runtime"])
                continue
              let session: Pick<Session, "id" | "title" | "parentID"> | undefined
              if (sessionID) {
                try {
                  const response = await sdk.client.session.get(
                    { sessionID, scopeID: directory === "global" ? undefined : directory },
                    {
                      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
                      throwOnError: true,
                    },
                  )
                  if (!current()) return
                  const value = response.data
                  if (!value || value.id !== sessionID || (directory !== "global" && value.scope.id !== directory))
                    continue
                  session = { id: value.id, title: value.title, parentID: value.parentID }
                } catch {
                  if (!current()) return
                  continue
                }
              }
              if (!current()) return
              const value = resolveNotificationEvent({ directory, event, session, copy: copy() })
              if (!value) continue
              const activate = () => {
                if (!current()) return
                if (space) space.openPersonal(sdk.runtimeID, directory, sessionID)
              }
              state.append({
                directory,
                session: value.sessionID,
                time: Date.now(),
                viewed: false,
                ...(value.type === "turn-complete" ? { type: "turn-complete" } : { type: "error", error: value.error }),
              })
              const background = !!space && space.selected() !== undefined
              const description = background
                ? `${translate({ id: "app.sidebar.space.personal", message: "Personal space" })} · ${value.description}`
                : value.description
              emit({ ...value, description }, { activate, current }, background, `session-${value.sessionID}`)
            }
          } finally {
            processing = false
          }
        }
        const unsubscribe = sdk.event.listen((input) => {
          const event = input.details
          if (!current() || (event.type !== "session.completion" && event.type !== "session.error")) return
          queue.push({ directory: input.name, event: structuredClone(event) })
          if (queue.length > MAX_NOTIFICATIONS) queue.shift()
          void drain().catch(() => {})
        })
        onCleanup(() => {
          lifetime.abort()
          queue.length = 0
          unsubscribe()
        })
        return { ...state, dispose }
      })
      setPersonal(state)
      onCleanup(() => {
        state.dispose()
        if (personal() === state) setPersonal(undefined)
      })
    })
    const subscribed = new Map<string, () => void>()
    createEffect(() => {
      const entries = space?.connections.filter((entry) => entry.state === "ready") ?? []
      const ready = new Set(entries.map(organizationSpaceKey))
      for (const [key, dispose] of subscribed)
        if (!ready.has(key)) {
          dispose()
          subscribed.delete(key)
        }
      untrack(() =>
        setOrganizations("list", (list) =>
          list.filter((value) => value.organization && ready.has(spaceKey(value.organization.identity))),
        ),
      )
      if (!space) return
      for (const key of ready) {
        if (subscribed.has(key)) continue
        const dispose = space.subscribeNotifications(key, (notice, owner) =>
          untrack(() => {
            if (!owner.current()) return
            const entry = space.connections.find((entry) => organizationSpaceKey(entry) === key)
            if (!entry || entry.state !== "ready") return
            const organization = {
              identity: {
                kind: "organization" as const,
                orgID: owner.audience.orgID,
                accountID: owner.audience.accountID,
                deploymentIncarnation: owner.audience.deploymentIncarnation,
              },
              projectID: notice.binding.projectID,
              name: `${entry.name ?? entry.issuer} · ${entry.account.displayName}`,
            }
            const value = resolveOrganizationNotice({ notice, organization, copy: copy() })
            if (!value) return
            const activate = () => {
              if (!owner.current()) return
              const current = space.connections.find((entry) => organizationSpaceKey(entry) === key)
              if (!current || current.state !== "ready") return
              space.open(key, organization.projectID, "sessions", value.sessionID)
            }
            const base = { session: value.sessionID, organization, time: Date.now(), viewed: false }
            const notification: Notification =
              value.type === "turn-complete"
                ? { ...base, type: "turn-complete" }
                : { ...base, type: "error", error: value.error }
            setOrganizations("list", (list) => pruneNotifications([...list, notification]))
            emit(
              value,
              { activate, current: owner.current },
              space.selected() !== key,
              `organization-${key}-session-${value.sessionID}`,
            )
          }),
        )
        subscribed.set(key, dispose)
      }
    })
    onCleanup(() => {
      for (const dispose of subscribed.values()) dispose()
      subscribed.clear()
    })
    const list = () => personal()?.list() ?? []
    return {
      ready: () => personal()?.ready() ?? true,
      session: {
        all(session: string) {
          return list().filter((value) => value.session === session)
        },
        unseen(session: string) {
          return list().filter((value) => value.session === session && !value.viewed)
        },
        markViewed(session: string) {
          personal()?.markViewed((value) => value.session === session)
        },
      },
      project: {
        all(directory: string) {
          return list().filter((value) => value.directory === directory)
        },
        unseen(directory: string) {
          return list().filter((value) => value.directory === directory && !value.viewed)
        },
        markViewed(directory: string) {
          personal()?.markViewed((value) => value.directory === directory)
        },
      },
      organization: {
        all(key: string) {
          return organizations.list.filter(
            (value) => value.organization && spaceKey(value.organization.identity) === key,
          )
        },
      },
    }
  },
})
