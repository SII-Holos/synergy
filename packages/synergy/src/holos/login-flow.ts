import { HolosAuth } from "./auth"
import { HOLOS_PORTAL_URL, HOLOS_URL } from "./constants"
import { HolosProfile } from "./profile"
import { HolosProtocol } from "./protocol"

export namespace HolosLoginFlow {
  export interface ExchangeResult {
    agentId: string
    agentSecret: string
  }

  export function createBindUrl(input: { callbackUrl: string; state: string }) {
    return (
      `${HOLOS_PORTAL_URL}/api/v1/holos/agent_tunnel/bind/start` +
      `?local_callback=${encodeURIComponent(input.callbackUrl)}` +
      `&state=${encodeURIComponent(input.state)}`
    )
  }

  export async function exchange(input: { code: string; state: string }): Promise<ExchangeResult> {
    const profile = await HolosProfile.get()
    const exchangeRes = await fetch(`${HOLOS_URL}/api/v1/holos/agent_tunnel/bind/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        state: input.state,
        profile: profile ? { name: profile.name, bio: profile.bio } : { name: "Synergy Agent" },
      }),
    })

    if (!exchangeRes.ok) {
      throw new Error(`Exchange failed: ${exchangeRes.status} ${exchangeRes.statusText}`)
    }

    const body = HolosProtocol.BindExchangeResponse.parse(await exchangeRes.json())
    if (body.code !== 0) {
      throw new Error(`Exchange failed: ${body.message}`)
    }

    return {
      agentId: body.data.agent_id,
      agentSecret: body.data.agent_secret ?? body.data.secret ?? "",
    }
  }

  export async function saveAndReload(input: ExchangeResult) {
    await HolosAuth.saveCredentialsAndConfigure(input.agentId, input.agentSecret)
    HolosAuth.reloadRuntime().catch(() => undefined)
  }
}
