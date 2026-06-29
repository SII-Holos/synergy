import z from "zod"
import { Contact } from "./contact"
import { Presence } from "./presence"
import { HolosReadiness } from "./readiness"
import { HolosAccounts } from "./accounts"
import { HolosProfile } from "./profile"

export namespace HolosState {
  export const ConnectionStatus = z.enum(["connected", "connecting", "disconnected", "disabled", "failed", "unknown"])
  export type ConnectionStatus = z.infer<typeof ConnectionStatus>

  export const AccountMeta = z
    .object({
      agentId: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "HolosAccountMeta" })
  export type AccountMeta = z.infer<typeof AccountMeta>

  export const Identity = z
    .object({
      loggedIn: z.boolean(),
      agentId: z.string().nullable(),
      activeAccount: AccountMeta.nullable(),
      accounts: AccountMeta.array(),
    })
    .meta({ ref: "HolosIdentityState" })
  export type Identity = z.infer<typeof Identity>

  export const Connection = z
    .object({
      status: ConnectionStatus,
      error: z.string().optional(),
    })
    .meta({ ref: "HolosConnectionState" })
  export type Connection = z.infer<typeof Connection>

  export const Readiness = z
    .object({
      ready: z.boolean(),
      reason: z.enum(["not_logged_in", "not_connected"]).optional(),
    })
    .meta({ ref: "HolosReadinessState" })
  export type Readiness = z.infer<typeof Readiness>

  export const Social = z
    .object({
      profile: HolosProfile.Info.nullable(),
      profileError: z.string().optional(),
      contacts: Contact.Info.array(),
      presence: z.record(z.string(), z.enum(["online", "offline", "unknown"])),
    })
    .meta({ ref: "HolosSocialState" })
  export const Info = z
    .object({
      identity: Identity,
      connection: Connection,
      readiness: Readiness,
      social: Social,
    })
    .meta({ ref: "HolosState" })
  export type Info = z.infer<typeof Info>

  function toAccountMeta(a: { agentId: string; createdAt: number; updatedAt: number }): AccountMeta {
    return {
      agentId: a.agentId,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }
  }

  async function fetchProfile(input: {
    credential: HolosReadiness.Snapshot["credential"]
  }): Promise<{ profile: HolosProfile.Info | null; profileError?: string }> {
    if (!input.credential) return { profile: null }
    try {
      const { Config } = await import("@/config/config")
      const config = await Config.current().catch(() => undefined)
      const me = await HolosProfile.getCurrent({
        agentId: input.credential.agentId,
        agentSecret: input.credential.agentSecret,
        apiUrl: config?.holos?.apiUrl,
      })
      return { profile: me.profile }
    } catch (err) {
      return {
        profile: null,
        profileError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  export async function get(): Promise<Info> {
    const [{ credential, status, readiness }, contacts, accounts] = await Promise.all([
      HolosReadiness.snapshot(),
      Contact.list(),
      HolosAccounts.listAccounts(),
    ])
    const profileState = await fetchProfile({ credential })

    const activeAccount = accounts.find((a) => a.agentId === credential?.agentId) ?? null

    const presenceEntries = Presence.all()
    const presence: Record<string, Presence.Status> = {}
    for (const [id, value] of presenceEntries) {
      presence[id] = value
    }

    return {
      identity: {
        loggedIn: !!credential,
        agentId: credential?.agentId ?? null,
        activeAccount: activeAccount ? toAccountMeta(activeAccount) : null,
        accounts: accounts.map(toAccountMeta),
      },
      connection: {
        status: status.status,
        ...(status.status === "failed" ? { error: status.error } : {}),
      },
      readiness,
      social: {
        profile: profileState.profile,
        ...(profileState.profileError ? { profileError: profileState.profileError } : {}),
        contacts,
        presence,
      },
    }
  }
}
