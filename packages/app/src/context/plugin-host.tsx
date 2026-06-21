import { createContext, useContext, type JSX } from "solid-js"

export interface PluginHost {
  pluginId: string
  serverUrl: string
  UIApiVersion: string
  theme: () => "light" | "dark"
}

const PluginHostContext = createContext<PluginHost>()

export function PluginHostProvider(props: { value: PluginHost; children: JSX.Element }) {
  return <PluginHostContext.Provider value={props.value}>{props.children}</PluginHostContext.Provider>
}

export function usePluginHost(): PluginHost {
  const ctx = useContext(PluginHostContext)
  if (!ctx) throw new Error("usePluginHost must be used within a PluginHostProvider")
  return ctx
}
