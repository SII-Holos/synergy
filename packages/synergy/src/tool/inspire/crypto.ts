export namespace InspireCrypto {
  const MODULUS = BigInt(
    "0x008aed7e057fe8f14c73550b0e6467b023616ddc8fa91846d2613cdb7f7621e3cada4cd5d812d627af6b87727ade4e26d26208b7326815941492b2204c3167ab2d53df1e3a2c9153bdb7c8c2e968df97a5e7e01cc410f92c4c2c2fba529b3ee988ebc1fca99ff5119e036d732c368acf8beba01aa2fdafa45b21e4de4928d0d403",
  )
  const EXPONENT = BigInt(0x010001)

  function biHighIndex(n: bigint): number {
    if (n === 0n) return 0
    let bits = 0
    let v = n
    while (v > 0n) {
      bits++
      v >>= 1n
    }
    return Math.floor((bits + 15) / 16) - 1
  }

  const CHUNK_SIZE = 2 * biHighIndex(MODULUS)
  const CIPHERTEXT_HEX_LENGTH = 4 * (biHighIndex(MODULUS) + 1)

  function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n
    base = base % mod
    while (exp > 0n) {
      if (exp % 2n === 1n) {
        result = (result * base) % mod
      }
      exp >>= 1n
      base = (base * base) % mod
    }
    return result
  }

  function encodeBlock(bytes: number[], start: number, chunkSize: number): bigint {
    let block = 0n
    let digitIndex = 0n
    for (let k = start; k < start + chunkSize; k += 2) {
      const byte1 = k < bytes.length ? bytes[k] : 0
      const byte2 = k + 1 < bytes.length ? bytes[k + 1] : 0
      const digit = BigInt(byte1 + (byte2 << 8))
      block += digit << (16n * digitIndex)
      digitIndex++
    }
    return block
  }

  function isEncrypted(password: string): boolean {
    return password.length >= 254 && password.length <= 256 && /^[0-9a-fA-F]+$/.test(password)
  }

  export function encryptPassword(password: string): string {
    if (isEncrypted(password)) return password

    const bytes = Array.from(password, (c) => c.charCodeAt(0))
    while (bytes.length % CHUNK_SIZE !== 0) bytes.push(0)

    const parts: string[] = []
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const block = encodeBlock(bytes, i, CHUNK_SIZE)
      const encrypted = powMod(block, EXPONENT, MODULUS)
      parts.push(encrypted.toString(16).padStart(CIPHERTEXT_HEX_LENGTH, "0"))
    }
    return parts.join("")
  }
}
