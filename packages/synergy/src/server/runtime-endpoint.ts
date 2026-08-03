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

function endpointError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "PluginHostServiceError", code })
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

function listenerUrl(hostname: string, port: number) {
  const host = hostname === "::1" ? "[::1]" : hostname
  return new URL(`http://${host}:${port}`).origin
}

export function configureRuntimeEndpoint(value: Listener | undefined) {
  listener = value ? { ...value, generation: value.generation ?? crypto.randomUUID() } : undefined
  return listener?.generation
}

export function peekRuntimeEndpoint(): RuntimeEndpoint | undefined {
  if (!listener || !isLoopback(listener.hostname)) return undefined
  return {
    url: listenerUrl(listener.hostname, listener.port),
    generation: listener.generation!,
  }
}

export function peekRuntimeEndpointGeneration(): string | undefined {
  return listener?.generation
}

export function getRuntimeEndpoint(): RuntimeEndpoint {
  if (!listener) {
    throw endpointError("PLUGIN_RUNTIME_ENDPOINT_UNAVAILABLE", "The Synergy runtime endpoint is not available")
  }
  if (!isLoopback(listener.hostname)) {
    throw endpointError(
      "PLUGIN_RUNTIME_ENDPOINT_UNSAFE",
      "The Synergy runtime endpoint is not bound to a loopback address",
    )
  }
  return {
    url: listenerUrl(listener.hostname, listener.port),
    generation: listener.generation!,
  }
}
