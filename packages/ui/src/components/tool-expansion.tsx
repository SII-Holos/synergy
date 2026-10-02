import { createContext, useContext, type ParentProps } from "solid-js"

export type ToolExpansionState = { get(partID: string): boolean | undefined; set(partID: string, open: boolean): void }
const State = createContext<ToolExpansionState>()
const Identity = createContext<string>()
export function ToolExpansionProvider(props: ParentProps<{ value: ToolExpansionState }>) {
  return <State.Provider value={props.value}>{props.children}</State.Provider>
}
export function ToolExpansionIdentity(props: ParentProps<{ partID: string }>) {
  return <Identity.Provider value={props.partID}>{props.children}</Identity.Provider>
}
export function useToolExpansion() {
  const state = useContext(State)
  const identity = useContext(Identity)
  if (!state || !identity) return
  return { get: () => state.get(identity), set: (open: boolean) => state.set(identity, open) }
}
