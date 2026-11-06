import { createContext, useContext, type ParentProps } from "solid-js"

interface UIStyleOwner {
  pluginId(): string
  skinId(): string | undefined
}
const Context = createContext<UIStyleOwner>({ pluginId: () => "synergy", skinId: () => undefined })
export const useUIStyle = () => useContext(Context)

export function UIStyleProvider(props: ParentProps<{ pluginId?: string; skinId?: string; reset?: boolean }>) {
  const parent = useUIStyle()
  return (
    <Context.Provider
      value={{
        pluginId: () => props.pluginId ?? (props.reset ? "synergy" : parent.pluginId()),
        skinId: () => props.skinId ?? (props.reset ? undefined : parent.skinId()),
      }}
    >
      {props.children}
    </Context.Provider>
  )
}

export function PortalStyleOwner(props: ParentProps) {
  const owner = useUIStyle()
  return (
    <div data-plugin-ui={owner.pluginId()} data-skin-root={owner.skinId()} style={{ display: "contents" }}>
      {props.children}
    </div>
  )
}
