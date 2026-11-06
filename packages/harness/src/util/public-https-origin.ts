import net from "node:net"

const ERROR_MESSAGE = "Local embedding custom source must be a public HTTPS origin"

function isPrivateIPv4(hostname: string) {
  const octets = hostname.split(".").map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false
  }
  const [first, second] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  )
}

function isPrivateIPv6(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (normalized === "::" || normalized === "::1") return true
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length)
    return net.isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true
  }

  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16)
  if (!Number.isFinite(firstHextet)) return true
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    firstHextet >= 0xff00
  )
}

function isPublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return false
  const family = net.isIP(normalized)
  if (family === 4) return !isPrivateIPv4(normalized)
  if (family === 6) return !isPrivateIPv6(normalized)
  return true
}

export function normalizePublicHttpsOrigin(input: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(ERROR_MESSAGE)
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isPublicHostname(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(ERROR_MESSAGE)
  }
  return url.origin + "/"
}
