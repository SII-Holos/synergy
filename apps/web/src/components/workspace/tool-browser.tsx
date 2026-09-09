import { lazy } from "solid-js"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"

const BrowserPanel = lazy(() => import("./browser/browser-panel").then((module) => ({ default: module.BrowserPanel })))

export function BrowserWorkbenchContent(props: WorkbenchPanelContentProps) {
  return <BrowserPanel tab={props.tab} />
}
