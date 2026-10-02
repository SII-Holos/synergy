import { createContext, useContext, type ParentProps } from "solid-js"

const Context = createContext<() => void>(() => {})
export function SessionSurfaceFocusProvider(props: ParentProps<{ value(): void }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}
export const useSessionSurfaceFocus = () => useContext(Context)
