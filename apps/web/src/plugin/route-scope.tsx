import { createEffect, createMemo, createResource, Show, type Accessor, type JSX } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { resolvePluginScopeKey } from "./scope-key"

export function PluginRouteScope(props: { children: (scopeKey: Accessor<string>) => JSX.Element }) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const scopeKey = createMemo(() => resolvePluginScopeKey(params.dir, location.search))
  const legacyDirectory = createMemo(() => (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(scopeKey()) ? scopeKey() : undefined))
  const [resolved] = createResource(legacyDirectory, async (directory) => {
    const { data } = await sdk.client.scope.current({ directory })
    if (!data) throw new Error("The project link could not be resolved")
    return { directory, scopeID: data.id }
  })
  createEffect(() => {
    const result = resolved()
    if (!result || result.directory !== legacyDirectory()) return
    const search = new URLSearchParams(location.search)
    const pathname = params.dir
      ? location.pathname.replace(`/${params.dir}`, `/${base64Encode(result.scopeID)}`)
      : location.pathname
    if (!params.dir) search.set("_scope", base64Encode(result.scopeID))
    const query = search.toString()
    navigate(`${pathname}${query ? `?${query}` : ""}${location.hash}`, { replace: true })
  })
  return <Show when={!legacyDirectory()}>{props.children(scopeKey)}</Show>
}
