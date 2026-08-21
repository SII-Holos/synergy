import { SmartTool } from "@ericsanchezok/synergy-ui/basic-tool"
import {
  externalFallbackLookup,
  notifyExternalToolLoaded,
  setExternalToolLookup,
  type ToolComponent,
  type ToolProps,
} from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { ErrorBoundary, createComponent } from "solid-js"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

type Loader = () => Promise<{ default: ToolComponent }>

function fallbackRenderer(props: ToolProps) {
  return createComponent(SmartTool, {
    get tool() {
      return props.tool
    },
    get input() {
      return props.input
    },
    get title() {
      return props.title
    },
    get output() {
      return props.output
    },
    get status() {
      return props.status
    },
    get charsReceived() {
      return props.charsReceived
    },
    get metadata() {
      return props.metadata
    },
    get time() {
      return props.time
    },
    get hideDetails() {
      return props.hideDetails
    },
    get fallbackMeta() {
      return externalFallbackLookup?.(props.tool)
    },
  })
}

function safeRenderer(renderer: ToolComponent): ToolComponent {
  return (props) =>
    createComponent(ErrorBoundary, {
      fallback: () => fallbackRenderer(props),
      get children() {
        return createComponent(renderer, props)
      },
    })
}

/** Internal slot entry: one renderer per host tool name (single-replace). */
interface ToolSlotEntry extends SlotEntryBase {
  slot: "message.renderer"
  loader?: Loader
  component?: ToolComponent
}

const registry = new SlotRegistry<ToolSlotEntry>()
/** Per-tool disposer so re-registering a tool replaces the previous entry. */
const disposers = new Map<string, () => void>()
const loading = new Map<string, Loader>()

export function getPluginToolRenderer(name: string): ToolComponent | undefined {
  const entry = registry.get(name)
  if (!entry) return undefined
  if (entry.component) return entry.component
  const loader = entry.loader
  if (!loader || loading.get(name) === loader) return undefined
  loading.set(name, loader)
  void loader()
    .then(
      (module) => {
        if (registry.get(name) !== entry) return
        entry.component = safeRenderer(module.default)
        notifyExternalToolLoaded()
      },
      () => undefined,
    )
    .finally(() => {
      if (loading.get(name) === loader) loading.delete(name)
    })
  return undefined
}

export function registerPluginToolRenderer(name: string, loader: Loader): () => void {
  disposers.get(name)?.()
  const dispose = registry.register({ id: name, slot: "message.renderer", loader })
  disposers.set(name, dispose)
  notifyExternalToolLoaded()
  return () => {
    if (disposers.get(name) !== dispose) return
    disposers.delete(name)
    dispose()
    notifyExternalToolLoaded()
  }
}

setExternalToolLookup(getPluginToolRenderer)
