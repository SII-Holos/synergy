import { type Accessor, type JSX } from "solid-js"
import { useLocation, useParams } from "@solidjs/router"
import { resolvePluginScopeKey } from "./scope-key"

export function PluginRouteScope(props: { children: (scopeKey: Accessor<string>) => JSX.Element }) {
  const params = useParams()
  const location = useLocation()
  const scopeKey = () => resolvePluginScopeKey(params.dir, location.search)
  return props.children(scopeKey)
}
