import { useExtensionOutlets } from "@ericsanchezok/synergy-ui/context/extension-outlet"
import {
  createComponent,
  createEffect,
  createSignal,
  createMemo,
  createResource,
  ErrorBoundary,
  onCleanup,
  Show,
  type Component,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ShellEntry, ShellRenderProps } from "./registries/shell-registry"

interface ShellSurfaceProps extends ShellRenderProps {
  requireOutlets?: boolean
  entry: ShellEntry
  loader: ShellEntry["loader"]
  fallback: Component<ShellRenderProps>
  reportError(error: { pluginId: string; message: string }): void
}

function VerifyShellOutlets(props: { render(): ReturnType<Component>; required: boolean }) {
  const outlets = useExtensionOutlets()
  const [error, setError] = createSignal<Error>()
  let active = true
  onCleanup(() => {
    active = false
  })
  createEffect(() => {
    if (!props.required || !outlets) return
    const missing = outlets.missingRequired()
    if (!missing.length) return
    queueMicrotask(() => {
      if (!active || !outlets.missingRequired().length) return
      setError(new Error(`Shell is missing required extension outlets: ${outlets.missingRequired().join(", ")}`))
    })
  })
  return Show({
    get when() {
      if (error()) throw error()
      return true
    },
    get children() {
      return props.render()
    },
  })
}

export function ShellSurface(props: ShellSurfaceProps) {
  const identity = createMemo(() => ({ entry: props.entry, loader: props.loader, sessionId: props.sessionId }))
  return Show({
    get when() {
      return identity()
    },
    keyed: true,
    children: (bound: ReturnType<typeof identity>) => {
      let active = true
      onCleanup(() => {
        active = false
      })
      const report = (error: unknown) => {
        if (active)
          props.reportError({
            pluginId: bound.entry.pluginId ?? "",
            message: error instanceof Error ? error.message : String(error),
          })
      }
      const render = (component: Component<ShellRenderProps>) =>
        createComponent(VerifyShellOutlets, {
          required: Boolean(props.requireOutlets && component !== props.fallback),
          render: () =>
            createComponent(Dynamic, {
              component,
              get shell() {
                return props.shell
              },
              sessionId: bound.sessionId,
              get input() {
                return props.input
              },
              get composerLayout() {
                return props.composerLayout
              },
              get conversation() {
                return props.conversation
              },
              get session() {
                return props.session
              },
              get workbench() {
                return props.workbench
              },
              get layout() {
                return props.layout
              },
            }),
        })
      const [component] = createResource(
        async () => {
          try {
            return (await bound.loader()).default
          } catch (error) {
            report(error)
            return props.fallback
          }
        },
        { initialValue: props.fallback },
      )
      return createComponent(ErrorBoundary, {
        fallback: (error) => {
          report(error)
          return render(props.fallback)
        },
        get children() {
          return render(component.latest)
        },
      })
    },
  })
}
