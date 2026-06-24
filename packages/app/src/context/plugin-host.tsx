import { createContext, useContext, type JSX } from "solid-js"

export interface SandboxPluginHostValue {
  pluginId: string
  serverUrl: string
  UIApiVersion: string
  theme: () => "light" | "dark"
}

const SandboxPluginHostContext = createContext<SandboxPluginHostValue>()

export function SandboxPluginHostProvider(props: { value: SandboxPluginHostValue; children: JSX.Element }) {
  return <SandboxPluginHostContext.Provider value={props.value}>{props.children}</SandboxPluginHostContext.Provider>
}

export function useSandboxPluginHost(): SandboxPluginHostValue {
  const ctx = useContext(SandboxPluginHostContext)
  if (!ctx) throw new Error("useSandboxPluginHost must be used within a SandboxPluginHostProvider")
  return ctx
}
