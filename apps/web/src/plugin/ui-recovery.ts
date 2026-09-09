import { createComponent, createContext, useContext, type ParentProps } from "solid-js"

const RecoveryContext = createContext(false)

export function resolveSafeUI(search: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): boolean {
  const flag = new URLSearchParams(search).get("safe-ui")
  const key = "synergy.safe-ui"
  if (flag === "1") storage.setItem(key, "1")
  if (flag === "0") storage.removeItem(key)
  return storage.getItem(key) === "1"
}

export function PluginUIRecoveryProvider(props: ParentProps<{ search?: string }>) {
  const safeUI = resolveSafeUI(props.search ?? window.location.search, sessionStorage)
  return createComponent(RecoveryContext.Provider, {
    value: safeUI,
    get children() {
      return props.children
    },
  })
}

export function useSafeUI(): boolean {
  return useContext(RecoveryContext)
}
