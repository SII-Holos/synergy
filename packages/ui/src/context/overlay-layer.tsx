import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"

const Context = createContext<Accessor<HTMLElement | undefined>>(() => undefined)
export const useOverlayLayer = () => useContext(Context)
export function OverlayLayerProvider(props: ParentProps<{ layer: Accessor<HTMLElement | undefined> }>) {
  return <Context.Provider value={props.layer}>{props.children}</Context.Provider>
}
