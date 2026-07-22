import fs from "fs/promises"
import z from "zod"
import { Global } from "../global"

export namespace McpAuth {
  export const Tokens = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
  })
  export type Tokens = z.infer<typeof Tokens>

  export const ClientInfo = z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
    clientIdIssuedAt: z.number().optional(),
    clientSecretExpiresAt: z.number().optional(),
  })
  export type ClientInfo = z.infer<typeof ClientInfo>

  export const Entry = z.object({
    tokens: Tokens.optional(),
    clientInfo: ClientInfo.optional(),
    codeVerifier: z.string().optional(),
    oauthState: z.string().optional(),
    serverUrl: z.string().optional(), // Track the URL these credentials are for
  })
  export type Entry = z.infer<typeof Entry>

  export interface MutationOptions {
    isCurrent?: () => boolean
  }

  let cache: { filepath: string; data: Record<string, Entry> } | undefined
  let mutation: Promise<void> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const current = mutation.then(fn, fn)
    mutation = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  async function persist(data: Record<string, Entry>): Promise<void> {
    await Bun.write(Global.Path.authMcp, JSON.stringify(data, null, 2))
    await fs.chmod(Global.Path.authMcp, 0o600)
  }

  function mutate(mcpName: string, fn: (entry: Entry | undefined) => Entry | undefined | false): Promise<boolean> {
    return serialize(async () => {
      const data = await all()
      const next = fn(data[mcpName])
      if (next === false) return false
      if (next) data[mcpName] = next
      else delete data[mcpName]
      await persist(data)
      return true
    })
  }

  export function invalidateCache() {
    cache = undefined
  }

  export async function all(): Promise<Record<string, Entry>> {
    const filepath = Global.Path.authMcp
    if (cache?.filepath === filepath) return cache.data
    const file = Bun.file(filepath)
    const data = (await file.json().catch(() => ({}))) as Record<string, Entry>
    cache = { filepath, data }
    return data
  }

  export async function get(mcpName: string): Promise<Entry | undefined> {
    const data = await all()
    return data[mcpName]
  }

  /**
   * Get auth entry and validate it's for the correct URL.
   * Returns undefined if URL has changed (credentials are invalid).
   */
  export async function getForUrl(mcpName: string, serverUrl: string): Promise<Entry | undefined> {
    const entry = await get(mcpName)
    if (!entry) return undefined

    // If no serverUrl is stored, this is from an old version - consider it invalid
    if (!entry.serverUrl) return undefined

    // If URL has changed, credentials are invalid
    if (entry.serverUrl !== serverUrl) return undefined

    return entry
  }

  export async function set(mcpName: string, entry: Entry, serverUrl?: string): Promise<void> {
    await mutate(mcpName, () => {
      const next = { ...entry }
      if (serverUrl) next.serverUrl = serverUrl
      else delete next.serverUrl
      return next
    })
  }

  export async function remove(mcpName: string): Promise<void> {
    await mutate(mcpName, (entry) => (entry ? undefined : false))
  }

  export async function updateTokens(
    mcpName: string,
    tokens: Tokens,
    serverUrl?: string,
    options: MutationOptions = {},
  ): Promise<void> {
    await mutate(mcpName, (entry) =>
      options.isCurrent?.() === false ? false : { ...entry, tokens, serverUrl: serverUrl ?? entry?.serverUrl },
    )
  }

  export async function updateClientInfo(
    mcpName: string,
    clientInfo: ClientInfo,
    serverUrl?: string,
    options: MutationOptions = {},
  ): Promise<void> {
    await mutate(mcpName, (entry) =>
      options.isCurrent?.() === false ? false : { ...entry, clientInfo, serverUrl: serverUrl ?? entry?.serverUrl },
    )
  }

  export async function updateCodeVerifier(
    mcpName: string,
    codeVerifier: string,
    options: MutationOptions = {},
  ): Promise<void> {
    await mutate(mcpName, (entry) => (options.isCurrent?.() === false ? false : { ...entry, codeVerifier }))
  }

  export function clearCodeVerifier(mcpName: string, expected?: string): Promise<boolean> {
    return mutate(mcpName, (entry) => {
      if (!entry?.codeVerifier) return false
      if (expected !== undefined && entry.codeVerifier !== expected) return false
      const next = { ...entry }
      delete next.codeVerifier
      return next
    })
  }

  export async function updateOAuthState(
    mcpName: string,
    oauthState: string,
    options: MutationOptions = {},
  ): Promise<void> {
    await mutate(mcpName, (entry) => (options.isCurrent?.() === false ? false : { ...entry, oauthState }))
  }

  export async function getOAuthState(mcpName: string): Promise<string | undefined> {
    const entry = await get(mcpName)
    return entry?.oauthState
  }

  export function clearOAuthState(mcpName: string, expected?: string): Promise<boolean> {
    return mutate(mcpName, (entry) => {
      if (!entry?.oauthState) return false
      if (expected !== undefined && entry.oauthState !== expected) return false
      const next = { ...entry }
      delete next.oauthState
      return next
    })
  }

  /**
   * Check if stored tokens are expired.
   * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
   */
  export async function isTokenExpired(mcpName: string): Promise<boolean | null> {
    const entry = await get(mcpName)
    if (!entry?.tokens) return null
    if (!entry.tokens.expiresAt) return false
    return entry.tokens.expiresAt < Date.now() / 1000
  }
}
