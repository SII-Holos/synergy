import { SmartTool } from "@ericsanchezok/synergy-ui/basic-tool"
import {
  externalFallbackLookup,
  notifyExternalToolLoaded,
  setExternalToolLookup,
  type ToolComponent,
  type ToolProps,
} from "@ericsanchezok/synergy-ui/tool-registry-lazy"
import { ErrorBoundary, createComponent } from "solid-js"

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

const renderers = new Map<string, ToolComponent>()
const loaders = new Map<string, Loader>()
const loading = new Map<string, Loader>()

export function getPluginToolRenderer(name: string): ToolComponent | undefined {
  const renderer = renderers.get(name)
  if (renderer) return renderer
  const loader = loaders.get(name)
  if (!loader || loading.get(name) === loader) return undefined
  loading.set(name, loader)
  void loader()
    .then(
      (module) => {
        if (loaders.get(name) !== loader) return
        renderers.set(name, safeRenderer(module.default))
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
  loaders.set(name, loader)
  renderers.delete(name)
  notifyExternalToolLoaded()
  return () => {
    if (loaders.get(name) !== loader) return
    loaders.delete(name)
    renderers.delete(name)
    if (loading.get(name) === loader) loading.delete(name)
    notifyExternalToolLoaded()
  }
}

setExternalToolLookup(getPluginToolRenderer)
