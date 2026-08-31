import { PluginHostServiceErrorCode } from "@ericsanchezok/synergy-plugin"

export type RuntimeEndpoint = {
  url: string
  generation: string
}

type Listener = {
  hostname: string
  port: number
  generation?: string
}

let listener: Listener | undefined

function endpointError(code: PluginHostServiceErrorCode, message: string) {
  return Object.assign(new Error(message), { name: "PluginHostServiceError", code })
}

// Wildcard binds (0.0.0.0 / ::) also serve the loopback interface, so the
// contract-safe loopback URL is real and resolves to http://127.0.0.1:<port>.
// Only binds that exclude loopback (a concrete external address) are unsafe.
function isLoopbackReachable(hostname: string) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "::"
  )
}

function listenerUrl(hostname: string, port: number) {
  const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname === "::1" ? "[::1]" : hostname
  return new URL(`http://${host}:${port}`).origin
}

export function configureRuntimeEndpoint(value: Listener | undefined) {
  listener = value ? { ...value, generation: value.generation ?? crypto.randomUUID() } : undefined
  return listener?.generation
}

export function peekRuntimeEndpointGeneration(): string | undefined {
  if (!listener || !isLoopbackReachable(listener.hostname)) return undefined
  return listener.generation
}

export function getRuntimeEndpoint(): RuntimeEndpoint {
  if (!listener) {
    throw endpointError(
      PluginHostServiceErrorCode.RUNTIME_ENDPOINT_UNAVAILABLE,
      "The Synergy runtime endpoint is not available",
    )
  }
  if (!isLoopbackReachable(listener.hostname)) {
    throw endpointError(
      PluginHostServiceErrorCode.RUNTIME_ENDPOINT_UNSAFE,
      "The Synergy runtime endpoint is not reachable over loopback; start the server with --hostname 127.0.0.1 (or 0.0.0.0)",
    )
  }
  return {
    url: listenerUrl(listener.hostname, listener.port),
    generation: listener.generation!,
  }
}
