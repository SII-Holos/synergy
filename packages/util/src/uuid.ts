export interface UUIDCrypto {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

export interface UUIDEnvironment {
  crypto?: UUIDCrypto
  now?: () => number
  random?: () => number
}

let fallbackCounter = 0

export function generateUUID(environment?: UUIDEnvironment): string {
  const webCrypto = environment ? environment.crypto : globalThis.crypto

  try {
    if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID()
  } catch {
    // randomUUID may be exposed but blocked outside a secure context.
  }

  try {
    if (typeof webCrypto?.getRandomValues === "function") {
      const bytes = webCrypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      return formatUUID(bytes)
    }
  } catch {
    // Fall through for runtimes without a usable Web Crypto implementation.
  }

  fallbackCounter += 1
  const now = environment?.now?.() ?? Date.now()
  const random = environment?.random?.() ?? Math.random()
  return `${now.toString(36)}-${fallbackCounter.toString(36)}-${random.toString(36).slice(2)}`
}

function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}
