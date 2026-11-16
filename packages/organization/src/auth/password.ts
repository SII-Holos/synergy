import { fail } from "../error"

// Provenance: https://bun.sh/docs/runtime/hashing
// Local adaptation: explicit Argon2id costs and bounded work per organization service.
export async function createPasswordHasher(concurrency = 2) {
  let active = 0
  const waiting: Array<() => void> = []
  async function run<T>(operation: () => Promise<T>) {
    if (active >= concurrency) {
      if (waiting.length >= concurrency * 8) fail("SERVICE_UNAVAILABLE", "Password verification is busy")
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else active++
    try {
      return await operation()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  const hash = (password: string) =>
    run(() => Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 }))
  const dummy = await hash("No account is authenticated by this password")
  return {
    hash,
    verify: (password: string, encoded?: string) => run(() => Bun.password.verify(password, encoded ?? dummy)),
  }
}
