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
  const hasExplicitQueryOrFragment = raw.includes("?") || raw.includes("#")
  if (!url.hostname || url.username || url.password || url.hash || url.search || hasExplicitQueryOrFragment) {
    throw new Error(`Invalid Holos ${kind} URL structure`)
  }
  if (url.pathname.split("/").some((segment) => segment.toLowerCase() === "api")) {
    throw new Error(`Holos ${kind} URL must be a base URL without an api/v1 route prefix`)
  }
  if ((url.protocol === "http:" || url.protocol === "ws:") && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Insecure Holos ${kind} endpoint is only allowed on loopback`)
  }
  return url
}

export function validateHolosPortalUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid Holos portal URL")
  }
  const hasExplicitQueryOrFragment = raw.includes("?") || raw.includes("#")
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    hasExplicitQueryOrFragment
  ) {
    throw new Error("Invalid Holos portal URL structure")
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Insecure Holos portal URL is only allowed on loopback")
  }
  return url
}
