const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function validateHolosEndpoint(raw: string, kind: "api" | "ws"): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid Holos ${kind} URL`)
  }

  const expected = kind === "api" ? ["https:", "http:"] : ["wss:", "ws:"]
  if (!expected.includes(url.protocol)) throw new Error(`Invalid Holos ${kind} URL scheme`)
  if (!url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error(`Invalid Holos ${kind} URL structure`)
  }
  if ((url.protocol === "http:" || url.protocol === "ws:") && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Insecure Holos ${kind} endpoint is only allowed on loopback`)
  }
  return url
}
