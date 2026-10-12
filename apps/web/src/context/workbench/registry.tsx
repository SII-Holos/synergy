import { createContext, createRenderEffect, onCleanup, useContext, type ParentProps } from "solid-js"
import {
  createWorkbenchPanelRegistry,
  getWorkbenchPanel,
  listWorkbenchPanels,
  registerWorkbenchPanel,
  subscribeWorkbenchPanels,
} from "@/plugin/registries/workbench-panel-registry"
import { useViewActivity } from "../view-residency"

const Context = createContext<ReturnType<typeof createWorkbenchPanelRegistry>>()
const global = {
  get: getWorkbenchPanel,
  list: listWorkbenchPanels,
  register: registerWorkbenchPanel,
  subscribe: subscribeWorkbenchPanels,
}
export const useWorkbenchPanelRegistry = () => useContext(Context) ?? global
export function WorkbenchPanelRegistryProvider(props: ParentProps) {
  const registry = createWorkbenchPanelRegistry()
  const active = useViewActivity()
  createRenderEffect(() => {
    if (active()) onCleanup(registry.activate())
  })
  return <Context.Provider value={registry}>{props.children}</Context.Provider>
}
