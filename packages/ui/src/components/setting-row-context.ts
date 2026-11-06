import { createContext, useContext } from "solid-js"

export const SettingRowContext = createContext<{ title: string; titleId: string; descriptionId: string }>()
export const useSettingRow = () => useContext(SettingRowContext)
