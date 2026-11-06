import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserNativePresentationCapabilityResult,
} from "@ericsanchezok/synergy-browser-core"
import type { BrowserNativeViewBridge } from "@/context/platform"

export function createBrowserSettingsCapability(input: {
  selection(): unknown
  selected(): boolean
  serverUrl(): string
  bridge(): Pick<BrowserNativeViewBridge, "presentationCapability" | "profileDataAction"> | undefined
}) {
  const [capability, setCapability] = createSignal<BrowserNativePresentationCapabilityResult>()
  const [revision, setRevision] = createSignal(0)
  let generation = 0
  onCleanup(() => {
    generation++
  })
  createEffect(() => {
    const selection = input.selection(),
      selected = input.selected(),
      serverUrl = input.serverUrl(),
      bridge = input.bridge()
    revision()
    const token = ++generation
    setCapability(undefined)
    if (!selection || !selected || !bridge?.profileDataAction) return
    void untrack(() => bridge.presentationCapability({ protocolVersion: BROWSER_PROTOCOL_VERSION, serverUrl }))
      .then((value) => {
        if (token === generation) setCapability(value)
      })
      .catch(() => undefined)
  })
  return {
    visible: () => input.selected() && Boolean(capability()?.managedLocal),
    ready: () => capability()?.protocolVersion === BROWSER_PROTOCOL_VERSION && capability()?.status === "ready",
    retry: () => setRevision((value) => value + 1),
  }
}
