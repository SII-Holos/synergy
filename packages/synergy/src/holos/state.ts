import z from "zod"
import { Contact } from "./contact"
import { HolosProfile } from "./profile"
import { Presence } from "./presence"
import { HolosReadiness } from "./readiness"

export namespace HolosState {
  export const ConnectionStatus = z.enum(["connected", "connecting", "disconnected", "disabled", "failed", "unknown"])
  export type ConnectionStatus = z.infer<typeof ConnectionStatus>

  export const Identity = z
    .object({
      loggedIn: z.boolean(),
      agentId: z.string().nullable(),
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

  export async function get(): Promise<Info> {
    const [{ credential, status, readiness }, profile, contacts] = await Promise.all([
      HolosReadiness.snapshot(),
      HolosProfile.get(),
      Contact.list(),
    ])

    const presenceEntries = Presence.all()
    const presence: Record<string, Presence.Status> = {}
    for (const [id, value] of presenceEntries) {
      presence[id] = value
    }

    return {
      identity: {
        loggedIn: !!credential,
        agentId: credential?.agentId ?? null,
      },
      connection: {
        status: status.status,
        ...(status.status === "failed" ? { error: status.error } : {}),
      },
      readiness,
      social: {
        profile: profile ?? null,
        contacts,
        presence,
      },
    }
  }
}
