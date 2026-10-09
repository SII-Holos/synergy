import { createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelTab } from "../../../src/plugin/registries/workbench-panel-registry"
import { createStore } from "solid-js/store"
import type { Message } from "@ericsanchezok/synergy-sdk"

const [data, setData] = createStore<{ message: Record<string, Message[]> }>({ message: {} })
export const setCanonicalMessages = (sessionID: string, messages: Message[]) => setData("message", sessionID, messages)
export const useSync = () => ({ data: { ...data, workspaces: [] } })

const surfaces = new Map<string, ReturnType<typeof createSurface>>()
function createSurface() {
  const [tabs, setTabs] = createSignal<WorkbenchPanelTab[]>([])
  const [active, setActive] = createSignal<string>()
  const [opened, setOpened] = createSignal(false)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [size, setSize] = createSignal(420)
  const [reveal, setReveal] = createSignal({ interacted: false })
  return {
    tabs,
    setTabs,
    active,
    setActive,
    activeTab: () => tabs().find((tab) => tab.id === active()),
    opened,
    setOpened,
    open: () => setOpened(true),
    close: () => setOpened(false),
    toggle: () => setOpened(!opened()),
    fullscreen,
    setFullscreen,
    size,
    setSize,
    reveal,
    setReveal,
  }
}
export const useLayout = () => ({
  isDesktop: () => true,
  sidebar: { opened: () => false, width: () => 0, occupiedWidth: () => 0 },
  surface(key: string, side: string) {
    const id = `${key}:${side}`
    if (!surfaces.has(id)) surfaces.set(id, createSurface())
    return surfaces.get(id)!
  },
  transferWorkbenchState() {},
})
export const useLocale = () => ({ i18n: useLingui().i18n() })
export const useConfirm = () => ({ ask: async () => true })
export const usePluginHost = () => ({ resources: { register: () => () => {} } })
export const useGlobalSDK = () => ({ capabilities: { has: () => false } })
export const useSDK = () => ({
  url: location.origin,
  scopeKey: "fixture",
  client: createSynergyClient({ baseUrl: location.origin }),
})
export const usePlatform = () => ({ fetch, openLink: () => {} })
export const openedFiles: string[] = []
export const useProjectFiles = () => ({
  open: async (_workspace: unknown, path: string) => {
    openedFiles.push(path)
    return { id: `file:${path}` }
  },
})
export const useFile = () => ({
  workspace: { id: "wsp_fixture", generation: 1, scopeID: "fixture", type: "local", path: "/fixture" },
  normalize: (value?: string) => (value?.startsWith("docs/") ? value : undefined),
  openWorkspaceFile: async () => {},
})
