import z from "zod"
import { HOLOS_URL } from "./constants"

export namespace HolosProfile {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .meta({ ref: "HolosAgentProfile" })
  export type Info = z.infer<typeof Info>

  export const Input = z
    .object({
      name: z.string().trim().min(1),
      description: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .meta({ ref: "HolosAgentProfileInput" })
  export type Input = z.infer<typeof Input>

  export const MeInfo = z
    .object({
      agentId: z.string(),
      profile: Info,
    })
    .meta({ ref: "HolosAgentMe" })
  export type MeInfo = z.infer<typeof MeInfo>

  export type RemoteProfile = Record<string, unknown>

  type Me = MeInfo & {
    rawProfile: RemoteProfile
  }

  const RemoteProfile = z.record(z.string(), z.unknown())
  const RemoteAgent = z
    .object({
      agent_id: z.string(),
      profile: RemoteProfile.nullable().optional(),
    })
    .passthrough()
  const RemoteEnvelope = z
    .object({
      code: z.number().optional(),
      msg: z.string().optional(),
      message: z.string().optional(),
      data: RemoteAgent,
    })
    .passthrough()

  function text(value: unknown): string {
    return typeof value === "string" ? value : ""
  }

  export function normalize(raw: unknown): Info {
    const profile = RemoteProfile.safeParse(raw).success ? (raw as RemoteProfile) : {}
    const avatarUrl = text(profile.avatar_url).trim()
    return {
      name: text(profile.name),
      description: text(profile.description),
      avatarUrl: avatarUrl ? avatarUrl : null,
    }
  }

  function cleanInput(input: Input): Required<Input> {
    return {
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      avatarUrl: input.avatarUrl?.trim() ?? "",
    }
  }

  export function toRemoteProfile(input: Input, existing?: RemoteProfile): RemoteProfile {
    const cleaned = cleanInput(input)
    return {
      ...(existing ?? {}),
      name: cleaned.name,
      description: cleaned.description,
      avatar_url: cleaned.avatarUrl,
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch {
      return undefined
    }
  }

  function unwrapMe(body: unknown): z.infer<typeof RemoteAgent> {
    const envelope = RemoteEnvelope.safeParse(body)
    if (envelope.success) {
      if (envelope.data.code !== undefined && envelope.data.code !== 0) {
        throw new Error(envelope.data.message ?? envelope.data.msg ?? "Holos profile request failed")
      }
      return envelope.data.data
    }

    const direct = RemoteAgent.safeParse(body)
    if (direct.success) return direct.data

    throw new Error("Holos profile response was not recognized")
  }

  function normalizeMe(data: z.infer<typeof RemoteAgent>): Me {
    const rawProfile = data.profile ?? {}
    return {
      agentId: data.agent_id,
      profile: normalize(rawProfile),
      rawProfile,
    }
  }

  function endpoint(path: string, apiUrl?: string): string {
    return new URL(path, apiUrl ?? HOLOS_URL).toString()
  }

  function authHeaders(agentSecret: string, extra?: HeadersInit): HeadersInit {
    return {
      Authorization: `Bearer ${agentSecret}`,
      ...(extra ?? {}),
    }
  }

  export async function getMe(input: { agentSecret: string; apiUrl?: string }): Promise<Me> {
    const res = await fetch(endpoint("/api/v1/holos/agent_tunnel/me", input.apiUrl), {
      headers: authHeaders(input.agentSecret),
    })
    const body = await readJson(res)
    if (!res.ok) {
      throw new Error(`Holos profile fetch failed: ${res.status} ${res.statusText}`)
    }
    return normalizeMe(unwrapMe(body))
  }

  export async function getCurrent(input: { agentId: string; agentSecret: string; apiUrl?: string }): Promise<MeInfo> {
    const me = await getMe(input)
    if (me.agentId !== input.agentId) {
      throw new Error(`Holos secret belongs to ${me.agentId}, not ${input.agentId}`)
    }
    return { agentId: me.agentId, profile: me.profile }
  }

  export async function updateCurrent(input: {
    agentId?: string
    agentSecret: string
    profile: Input
    apiUrl?: string
  }): Promise<MeInfo> {
    const current = await getMe({ agentSecret: input.agentSecret, apiUrl: input.apiUrl })
    if (input.agentId && current.agentId !== input.agentId) {
      throw new Error(`Holos secret belongs to ${current.agentId}, not ${input.agentId}`)
    }
    const nextProfile = toRemoteProfile(input.profile, current.rawProfile)
    const res = await fetch(endpoint("/api/v1/holos/agent_tunnel/me/profile", input.apiUrl), {
      method: "POST",
      headers: authHeaders(input.agentSecret, { "Content-Type": "application/json" }),
      body: JSON.stringify({ profile: nextProfile }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      throw new Error(`Holos profile save failed: ${res.status} ${res.statusText}`)
    }
    const updated = normalizeMe(unwrapMe(body))
    return {
      agentId: updated.agentId || current.agentId,
      profile: updated.profile,
    }
  }
}
