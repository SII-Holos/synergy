import { createEffect, createMemo, createSignal, onCleanup, onMount, ParentProps, Show, Switch, Match } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { usePlatform } from "@/context/platform"
import { createStore } from "solid-js/store"
import { showToast, Toast, toaster } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { PanelProvider, usePanel } from "@/context/panel"

import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme, type ColorScheme } from "@ericsanchezok/synergy-ui/theme"
import { DialogSelectProvider, DialogSelectServer, DialogSelectDirectory } from "@/components/dialog"
import { useCommand, type CommandOption } from "@/context/command"
import { navStart } from "@/utils/perf"
import { useServer } from "@/context/server"
import { isHostedMode } from "@/utils/runtime"
import { HeaderBar } from "@/components/header-bar"
import { MobileDrawer } from "@/components/mobile-drawer"
import { EngramPanel } from "@/components/engram"
import { AgendaPanel } from "@/components/agenda"
import { NotePanel } from "@/components/note-panel"
import { ScopesPanel } from "@/components/scopes"
import { HolosPanel } from "@/components/contacts"
import { LucidPanel } from "@/components/lucid-panel"

export default function Layout(props: ParentProps) {
  const [store, setStore] = createStore({
    lastSession: {} as { [directory: string]: string },
  })

  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const hosted = isHostedMode()
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeLabel: Record<ColorScheme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: "Color scheme",
      description: colorSchemeLabel[next],
    })
  }

  // Permission notification system
  onMount(() => {
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const permissionAlertCooldownMs = 5000

    const unsub = globalSDK.event.listen((e) => {
      if (e.details?.type !== "permission.asked") return
      const directory = e.name
      const perm = e.details.properties
      if (permission.isAllowingAll(perm.sessionID, directory)) return

      const [childStore] = globalSync.child(directory)
      const session = childStore.session.find((s) => s.id === perm.sessionID)
      const sessionKey = `${directory}:${perm.sessionID}`

      const sessionTitle = session?.title ?? "New session"
      const projectName = getFilename(directory)
      const description = `${sessionTitle} in ${projectName} needs permission`
      const href = `/${base64Encode(directory)}/session/${perm.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < permissionAlertCooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      void platform.notify("Permission required", description, href)

      const currentDir = params.dir ? base64Decode(params.dir) : undefined
      const currentSession = params.id
      if (directory === currentDir && perm.sessionID === currentSession) return

      const existingToastId = toastBySession.get(sessionKey)
      if (existingToastId !== undefined) {
        toaster.dismiss(existingToastId)
      }

      const toastId = showToast({
        persistent: true,
        icon: "shield-alert",
        title: "Permission required",
        description,
        actions: [
          {
            label: "Go to session",
            onClick: () => {
              navigate(href)
            },
          },
          {
            label: "Dismiss",
            onClick: "dismiss",
          },
        ],
      })
      toastBySession.set(sessionKey, toastId)
    })
    onCleanup(unsub)

    createEffect(() => {
      const currentDir = params.dir ? base64Decode(params.dir) : undefined
      const currentSession = params.id
      if (!currentDir || !currentSession) return
      const sessionKey = `${currentDir}:${currentSession}`
      const toastId = toastBySession.get(sessionKey)
      if (toastId !== undefined) {
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }
      const [childStore] = globalSync.child(currentDir)
      const childSessions = childStore.session.filter((s) => s.parentID === currentSession)
      for (const child of childSessions) {
        const childKey = `${currentDir}:${child.id}`
        const childToastId = toastBySession.get(childKey)
        if (childToastId !== undefined) {
          toaster.dismiss(childToastId)
          toastBySession.delete(childKey)
          alertedAtBySession.delete(childKey)
        }
      }
    })
  })

  // Derive current project and sessions from route params
  const currentProject = createMemo(() => {
    const directory = params.dir ? base64Decode(params.dir) : undefined
    if (!directory) return
    return layout.scopes.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })

  const currentSessions = createMemo(() => layout.nav.projectSessions(currentProject()))

  // Reset prefetch on directory/server change
  createEffect(() => {
    params.dir
    globalSDK.url
    layout.nav.resetPrefetch()
  })

  // Auto-prefetch adjacent sessions
  createEffect(() => {
    const sessions = currentSessions()
    const id = params.id

    if (!id) {
      const first = sessions[0]
      if (first) layout.nav.prefetchSession(first)
      const second = sessions[1]
      if (second) layout.nav.prefetchSession(second)
      return
    }

    const index = sessions.findIndex((s) => s.id === id)
    if (index === -1) return

    const next = sessions[index + 1]
    if (next) layout.nav.prefetchSession(next)

    const prev = sessions[index - 1]
    if (prev) layout.nav.prefetchSession(prev)
  })

  // Session navigation by offset (for keyboard shortcuts)
  function navigateSessionByOffset(offset: number) {
    const scopes = layout.scopes.list()
    if (scopes.length === 0) return

    const project = currentProject()
    const projectIndex = project ? scopes.findIndex((p) => p.worktree === project.worktree) : -1

    if (projectIndex === -1) {
      const targetProject = offset > 0 ? scopes[0] : scopes[scopes.length - 1]
      if (targetProject) navigateToProject(targetProject.worktree)
      return
    }

    const sessions = currentSessions()
    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = sessionIndex + offset
    }

    if (targetIndex >= 0 && targetIndex < sessions.length) {
      const session = sessions[targetIndex]
      const next = sessions[targetIndex + 1]
      const prev = sessions[targetIndex - 1]

      if (offset > 0) {
        if (next) layout.nav.prefetchSession(next, "high")
        if (prev) layout.nav.prefetchSession(prev)
      }
      if (offset < 0) {
        if (prev) layout.nav.prefetchSession(prev, "high")
        if (next) layout.nav.prefetchSession(next)
      }

      if (import.meta.env.DEV) {
        navStart({
          dir: base64Encode(session.scope.directory!),
          from: params.id,
          to: session.id,
          trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
        })
      }
      navigateToSession(session)
      return
    }

    const nextProjectIndex = projectIndex + (offset > 0 ? 1 : -1)
    const nextProject = scopes[nextProjectIndex]
    if (!nextProject) return

    const nextProjectSessions = layout.nav.projectSessions(nextProject)
    if (nextProjectSessions.length === 0) {
      navigateToProject(nextProject.worktree)
      return
    }

    const index = offset > 0 ? 0 : nextProjectSessions.length - 1
    const targetSession = nextProjectSessions[index]
    const nextSession = nextProjectSessions[index + 1]
    const prevSession = nextProjectSessions[index - 1]

    if (offset > 0 && nextSession) layout.nav.prefetchSession(nextSession, "high")
    if (offset < 0 && prevSession) layout.nav.prefetchSession(prevSession, "high")

    if (import.meta.env.DEV) {
      navStart({
        dir: base64Encode(targetSession.scope.directory!),
        from: params.id,
        to: targetSession.id,
        trigger: offset > 0 ? "alt+arrowdown" : "alt+arrowup",
      })
    }
    navigateToSession(targetSession)
  }

  // Commands
  command.register(() => {
    const commands: CommandOption[] = [
      {
        id: "project.open",
        title: "Open project",
        category: "Project",
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "session.previous",
        title: "Previous session",
        category: "Session",
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: "Next session",
        category: "Session",
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.archive",
        title: "Archive session",
        category: "Session",
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: async () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (!session) return
          const nextSession = await layout.nav.archiveSession(session)
          if (session.id === params.id) {
            if (nextSession) {
              navigate(`/${params.dir}/session/${nextSession.id}`)
            } else {
              navigate(`/${params.dir}/session`)
            }
          }
        },
      },
      {
        id: "theme.scheme.cycle",
        title: "Cycle color scheme",
        category: "Theme",
        keybind: "mod+shift+t",
        slash: "theme",
        onSelect: () => cycleColorScheme(1),
      },
      {
        id: "help.show",
        title: "Help",
        description: "Show all available commands",
        category: "General",
        slash: "help",
        onSelect: () => command.show(),
      },
      {
        id: "session.list",
        title: "List sessions",
        description: "Show sessions for current project",
        category: "Session",
        slash: "session",
        onSelect: () => {},
      },
    ]

    commands.push({
      id: "theme.scheme.cycle",
      title: "Cycle color scheme",
      category: "Theme",
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: `Use color scheme: ${colorSchemeLabel[scheme]}`,
        category: "Theme",
        onSelect: () => theme.setColorScheme(scheme),
      })
    }

    if (!hosted) {
      commands.splice(
        1,
        0,
        {
          id: "provider.connect",
          title: "Connect provider",
          category: "Provider",
          slash: "connect",
          onSelect: () => connectProvider(),
        },
        {
          id: "server.switch",
          title: "Switch server",
          category: "Server",
          onSelect: () => openServer(),
        },
      )
    }

    return commands
  })

  function connectProvider() {
    dialog.show(() => <DialogSelectProvider />)
  }

  function openServer() {
    dialog.show(() => <DialogSelectServer onSelected={() => navigate("/")} />)
  }

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const lastSession = store.lastSession[directory]
    navigate(`/${base64Encode(directory)}${lastSession ? `/session/${lastSession}` : ""}`)
  }

  function navigateToSession(session: Session | undefined) {
    const directory = session?.scope.directory
    if (!session || !directory) return
    navigate(`/${base64Encode(directory)}/session/${session.id}`)
  }

  function openProject(directory: string, nav = true) {
    layout.scopes.open(directory)
    if (nav) navigateToProject(directory)
  }

  async function chooseProject() {
    async function resolve(result: { directory: string | string[]; initGit: boolean } | null) {
      if (!result) return

      if (result.initGit) {
        const dirs = Array.isArray(result.directory) ? result.directory : [result.directory]
        for (const dir of dirs) {
          await globalSDK.client.git.init({ body_directory: dir }).catch(() => {})
        }
      }

      if (Array.isArray(result.directory)) {
        for (const directory of result.directory) {
          openProject(directory, false)
        }
        navigateToProject(result.directory[0])
      } else {
        openProject(result.directory)
      }
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} showInitGit={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  // Track last viewed session
  createEffect(() => {
    if (!params.dir || !params.id) return
    const directory = base64Decode(params.dir)
    const id = params.id
    setStore("lastSession", directory, id)
    notification.session.markViewed(id)
  })

  return (
    <PanelProvider>
      <LayoutContent>{props.children}</LayoutContent>
    </PanelProvider>
  )
}

const PANEL_DEFAULT = 45
const PANEL_MIN = 20
const MAIN_MIN_PX = 480

function LayoutContent(props: ParentProps) {
  const panel = usePanel()
  const layout = useLayout()
  const [panelWidth, setPanelWidth] = createSignal(PANEL_DEFAULT)
  const [resizing, setResizing] = createSignal(false)
  const isOpen = () => layout.isDesktop() && !!panel.active()

  const panelMax = () => Math.floor(((window.innerWidth - MAIN_MIN_PX) / window.innerWidth) * 100)

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startWidth = panelWidth()

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX
      const newPercent = startWidth + (delta / window.innerWidth) * 100
      setPanelWidth(Math.min(panelMax(), Math.max(PANEL_MIN, newPercent)))
    }

    const onMouseUp = () => {
      setResizing(false)
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const params = useParams()
  const isHome = () => !params.dir

  return (
    <div class="relative flex-1 min-h-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      <MobileDrawer />
      <Show when={!isHome()}>
        <HeaderBar />
      </Show>
      <div class="flex-1 min-h-0 flex overflow-hidden">
        <main
          class="flex-1 min-h-0 overflow-x-hidden flex flex-col contain-strict"
          style={{ "min-width": layout.isDesktop() ? `${MAIN_MIN_PX}px` : undefined }}
        >
          {props.children}
        </main>
        <div
          classList={{
            "relative h-full shrink-0 overflow-hidden": true,
            "border-l border-border-weaker-base/60 bg-background-stronger": isOpen(),
          }}
          style={{
            width: isOpen() ? `${panelWidth()}%` : "0%",
            "max-width": `calc(100% - ${MAIN_MIN_PX}px)`,
            ...(!resizing() && { transition: "width 250ms cubic-bezier(0.16, 1, 0.3, 1)" }),
          }}
        >
          <div class="h-full" style={{ "min-width": `${panelWidth()}vw` }}>
            <Show when={isOpen()}>
              <div
                class="absolute inset-y-0 left-0 w-2 -translate-x-1/2 cursor-ew-resize z-10 group"
                onMouseDown={handleResizeStart}
              >
                <div class="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-sm bg-border-strong-base opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity" />
              </div>
            </Show>
            <Switch>
              <Match when={panel.active() === "engram"}>
                <EngramPanel />
              </Match>
              <Match when={panel.active() === "agenda"}>
                <AgendaPanel />
              </Match>
              <Match when={panel.active() === "note"}>
                <NotePanel />
              </Match>
              <Match when={panel.active() === "scopes"}>
                <ScopesPanel />
              </Match>
              <Match when={panel.active() === "holos"}>
                <HolosPanel />
              </Match>
              <Match when={panel.active() === "lucid"}>
                <LucidPanel />
              </Match>
              <Match when={panel.hasSlot(panel.active()!)}>{panel.slot(panel.active()!)}</Match>
            </Switch>
          </div>
        </div>
      </div>
      <Toast.Region />
    </div>
  )
}
