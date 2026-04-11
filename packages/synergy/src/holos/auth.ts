import { Auth } from "@/provider/api-key"
import { Config } from "@/config/config"
import { Instance } from "@/scope/instance"
import { Scope } from "@/scope"
import { HOLOS_PORTAL_URL, HOLOS_URL, HOLOS_WS_URL } from "./constants"
import { HolosProtocol } from "./protocol"

export namespace HolosAuth {
  export type VerifyResult = { valid: true; agentId: string } | { valid: false; reason: string }

  export async function verifyCredentials(
    agentSecret: string,
  ): Promise<{ valid: true } | { valid: false; reason: string }> {
    const res = await fetch(`${HOLOS_URL}/api/v1/holos/agent_tunnel/ws_token`, {
      headers: { Authorization: `Bearer ${agentSecret}` },
    })
    const body = HolosProtocol.WsTokenResponse.safeParse(await res.json())
    if (!body.success || !res.ok || body.data.code !== 0) {
      const message = body.success ? body.data.message : "Unexpected response"
      return { valid: false, reason: message ?? `Validation failed: ${res.status}` }
    }
    return { valid: true }
  }

  export type StoredCredential = {
    agentId: string
    agentSecret: string
    maskedSecret: string
  }

  export async function getStoredCredential(): Promise<StoredCredential | undefined> {
    const credentials = await Auth.get("holos")
    if (!credentials || credentials.type !== "holos") return undefined
    const secret = credentials.agentSecret
    const masked =
      secret.length > 8 ? secret.slice(0, 4) + "•".repeat(12) + secret.slice(-4) : "•".repeat(secret.length)
    return {
      agentId: credentials.agentId,
      agentSecret: credentials.agentSecret,
      maskedSecret: masked,
    }
  }

  export async function verifyStoredCredentials(): Promise<VerifyResult> {
    const credential = await getStoredCredential()
    if (!credential) {
      return { valid: false, reason: "No Holos credentials stored" }
    }
    const result = await verifyCredentials(credential.agentSecret)
    if (!result.valid) {
      return result
    }
    return { valid: true, agentId: credential.agentId }
  }

  export async function getCredentialOrThrow(): Promise<StoredCredential> {
    const credential = await getStoredCredential()
    if (!credential) {
      throw new Error("Holos credentials are required. Run `synergy holos login` first.")
    }
    return credential
  }

  export async function saveCredentialsAndConfigure(agentId: string, agentSecret: string): Promise<void> {
    await Auth.set("holos", { type: "holos", agentId, agentSecret })
    await configureHolos()
  }

  export async function clearCredentials(): Promise<void> {
    await Auth.remove("holos")
  }

  export async function configureHolos(): Promise<void> {
    await Config.updateGlobal({
      holos: {
        enabled: true,
        apiUrl: HOLOS_URL,
        wsUrl: HOLOS_WS_URL,
        portalUrl: HOLOS_PORTAL_URL,
      },
    })
  }

  export async function reloadRuntime(): Promise<void> {
    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const { HolosRuntime } = await import("@/holos/runtime")
        await HolosRuntime.reload()
      },
    })
  }
}
