import { HolosAuth } from "./auth"
import { HolosEndpoint } from "./endpoint"
import { HolosProfile } from "./profile"
import { HolosProtocol } from "./protocol"

export namespace HolosLoginFlow {
  export interface ExchangeResult {
    agentId: string
    agentSecret: string
  }

  type BindUrlInput = { callbackUrl: string; state: string }

  function createBindUrlForPortal(input: BindUrlInput, portalBaseUrl: string): string {
    return (
      HolosEndpoint.url("/api/v1/holos/agent_tunnel/bind/start", portalBaseUrl) +
      `?local_callback=${encodeURIComponent(input.callbackUrl)}` +
      `&state=${encodeURIComponent(input.state)}`
    )
  }

  export function createBindUrl(input: BindUrlInput): string {
    return createBindUrlForPortal(input, HolosEndpoint.defaults.portalUrl)
  }

  export async function createConfiguredBindUrl(input: BindUrlInput): Promise<string> {
    const endpoints = await HolosEndpoint.resolve()
    return createBindUrlForPortal(input, endpoints.portalUrl)
  }

  export async function exchange(input: {
    code: string
    state: string
    profile: HolosProfile.Input
  }): Promise<ExchangeResult> {
    const endpoints = await HolosEndpoint.resolve()
    const exchangeRes = await fetch(HolosEndpoint.url("/api/v1/holos/agent_tunnel/bind/exchange", endpoints.apiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        state: input.state,
        profile: HolosProfile.toRemoteProfile(input.profile),
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
