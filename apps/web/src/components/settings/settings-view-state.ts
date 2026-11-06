import { createContext, useContext } from "solid-js"

export type SettingsViewState = {
  expanded(id: string): boolean | undefined
  setExpanded(id: string, open: boolean): void
  view?(id: string): string | undefined
  setView?(id: string, view: string): void
  searchField(): string | undefined
}
export const SettingsViewStateContext = createContext<SettingsViewState>()
export const useSettingsViewState = () => useContext(SettingsViewStateContext)
