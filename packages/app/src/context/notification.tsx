import { createStore } from "solid-js/store"
import { createEffect, onCleanup } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import { usePlatform } from "@/context/platform"
import { EventSessionError } from "@ericsanchezok/synergy-sdk"
import { makeAudioPlayer } from "@solid-primitives/audio"
import completionSound from "@ericsanchezok/synergy-ui/audio/staplebops-01.aac"
import errorSound from "@ericsanchezok/synergy-ui/audio/nope-03.aac"
import { Persist, persisted } from "@/utils/persist"
import { resolveNotificationEvent } from "./notification-event"
import { useLingui } from "@lingui/solid"
import { messages as AP } from "@/locales/messages"
import { findSessionByID } from "./session-collection"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: any
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

export const { use: useNotification, provider: NotificationProvider } = createSimpleContext({
  name: "Notification",
  init: () => {
    let completionPlayer: ReturnType<typeof makeAudioPlayer> | undefined
    let errorPlayer: ReturnType<typeof makeAudioPlayer> | undefined

    try {
      completionPlayer = makeAudioPlayer(completionSound)
      errorPlayer = makeAudioPlayer(errorSound)
    } catch (err) {
      console.log("Failed to load audio", err)
    }

    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()
    const platform = usePlatform()
    const { _: translate } = useLingui()

    const [store, setStore, _, ready] = persisted(
      Persist.global("notification", ["notification.v1"]),
      createStore({
        list: [] as Notification[],
      }),
    )

    const meta = { pruned: false }

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      meta.pruned = true
      setStore("list", pruneNotifications(store.list))
    })

    const append = (notification: Notification) => {
      setStore("list", (list) => pruneNotifications([...list, notification]))
    }

    const unsub = globalSDK.event.listen((e) => {
      const directory = e.name
      const event = e.details
      const base = {
        directory,
        time: Date.now(),
        viewed: false,
      }
      switch (event.type) {
        case "session.completion": {
          const sessionID = event.properties.sessionID
          const [syncStore] = globalSync.ensureScopeState(directory)
          const session = findSessionByID(syncStore.session, sessionID)
          const notification = resolveNotificationEvent({
            directory,
            event,
            session,
            copy: {
              responseReady: translate(AP.notification.responseReady),
              sessionError: translate(AP.notification.sessionError),
              errorFallback: translate(AP.notification.errorFallback),
            },
          })
          if (!notification || notification.type !== "turn-complete") break
          try {
            completionPlayer?.play()
          } catch {}
          append({
            ...base,
            type: "turn-complete",
            session: notification.sessionID,
          })
          void platform.notify(notification.title, notification.description, notification.href)
          break
        }
        case "session.error": {
          const sessionID = event.properties.sessionID
          const [syncStore] = globalSync.ensureScopeState(directory)
          const session = sessionID ? findSessionByID(syncStore.session, sessionID) : undefined
          const notification = resolveNotificationEvent({
            directory,
            event,
            session,
            copy: {
              responseReady: translate(AP.notification.responseReady),
              sessionError: translate(AP.notification.sessionError),
              errorFallback: translate(AP.notification.errorFallback),
            },
          })
          if (!notification || notification.type !== "error") break
          try {
            errorPlayer?.play()
          } catch {}
          append({
            ...base,
            type: "error",
            session: notification.sessionID,
            error: notification.error,
          })
          void platform.notify(notification.title, notification.description, notification.href)
          break
        }
      }
    })
    onCleanup(unsub)

    return {
      ready,
      session: {
        all(session: string) {
          return store.list.filter((n) => n.session === session)
        },
        unseen(session: string) {
          return store.list.filter((n) => n.session === session && !n.viewed)
        },
        markViewed(session: string) {
          setStore("list", (n) => n.session === session, "viewed", true)
        },
      },
      project: {
        all(directory: string) {
          return store.list.filter((n) => n.directory === directory)
        },
        unseen(directory: string) {
          return store.list.filter((n) => n.directory === directory && !n.viewed)
        },
        markViewed(directory: string) {
          setStore("list", (n) => n.directory === directory, "viewed", true)
        },
      },
    }
  },
})
