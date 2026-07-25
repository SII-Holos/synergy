export interface UUIDCrypto {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

export interface UUIDEnvironment {
  crypto?: UUIDCrypto
  now?: () => number
  random?: () => number
}

export class SecureRandomUnavailableError extends Error {
  constructor() {
    super("Secure randomness requires a usable Web Crypto implementation")
    this.name = "SecureRandomUnavailableError"
  }
}

export function generateRandomBytes(length: number, environment?: UUIDEnvironment): Uint8Array {
  const bytes = new Uint8Array(length)
  const webCrypto = environment ? environment.crypto : globalThis.crypto

  try {
    if (typeof webCrypto?.getRandomValues === "function") return webCrypto.getRandomValues(bytes)
  } catch {
    // Ordinary identifiers may use the weak fallback when Web Crypto is unavailable.
  }

  const random = environment?.random ?? Math.random
  for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(random() * 256)
  return bytes
}

export function generateSecureRandomBytes(length: number, environment?: UUIDEnvironment): Uint8Array {
  const webCrypto = environment ? environment.crypto : globalThis.crypto
  if (typeof webCrypto?.getRandomValues !== "function") throw new SecureRandomUnavailableError()
  try {
    return webCrypto.getRandomValues(new Uint8Array(length))
  } catch {
    throw new SecureRandomUnavailableError()
  }
}

export function generateSecureUUID(environment?: UUIDEnvironment): string {
  const webCrypto = environment ? environment.crypto : globalThis.crypto
  try {
    if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID()
  } catch {
    // Fall through to strict getRandomValues without a weak fallback.
  }
  return formatUUID(generateSecureRandomBytes(16, environment))
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
    if (typeof webCrypto?.getRandomValues === "function") return formatUUID(generateSecureRandomBytes(16, environment))
  } catch {
    // Fall through for runtimes without a usable Web Crypto implementation.
  }

  fallbackCounter += 1
  const now = environment?.now?.() ?? Date.now()
  const random = environment?.random?.() ?? Math.random()
  return `${now.toString(36)}-${fallbackCounter.toString(36)}-${random.toString(36).slice(2)}`
}

function formatUUID(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}
