import { lazy } from "solid-js"

const BrowserPanel = lazy(() => import("./browser/browser-panel").then((module) => ({ default: module.BrowserPanel })))

export function BrowserWorkbenchContent() {
  return <BrowserPanel />
}
