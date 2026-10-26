import fs from "node:fs/promises"
import path from "node:path"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { Auth } from "./api-key"
import { Global } from "../global"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function retired(value: unknown) {
  const entry = record(value)
  return entry?.authKind === "holos" || entry?.type === "holos" || record(entry?.auth)?.type === "holos"
}

async function retireFile(filename: string, wrapped: boolean) {
  const raw = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return
  const data: unknown = JSON.parse(raw)
  const store = record(data)
  const credentials = wrapped ? record(store?.credentials) : store
  if (!credentials) throw new Error("Cannot retire credentials from an invalid credential store")
  let changed = false
  for (const [id, value] of Object.entries(credentials)) {
    const entry = record(value)
    const pool = Array.isArray(entry?.pool) ? entry.pool.filter((item) => !retired(item)) : undefined
    if (retired(value)) {
      const replacement = pool?.map(record).find((item) => item !== undefined)
      if (entry && replacement) {
        for (const key of ["authKind", "tokens", "auth", "expiresAt", "metadata", "source", "updatedAt"]) {
          delete entry[key]
          if (key in replacement) entry[key] = replacement[key]
        }
        entry.pool = pool
      } else delete credentials[id]
      changed = true
      continue
    }
    if (!entry || !pool || !Array.isArray(entry.pool)) continue
    if (pool.length === entry.pool.length) continue
    entry.pool = pool
    changed = true
  }
  if (changed)
    await AtomicFile.writeFileAtomic(filename, JSON.stringify(data, null, 2) + "\n", { private: true, durable: true })
}

export async function retireNetworkCredentials() {
  await Auth.withLock("provider-auth-store:write", async () => {
    await retireFile(Global.Path.authProvider, true)
    await retireFile(Global.Path.authApiKey, false)
    await retireFile(`${Global.Path.authApiKey}.bak`, false)
    await fs.unlink(path.join(Global.Path.auth, "holos-accounts.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  })
}
