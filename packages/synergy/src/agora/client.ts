import { Flag } from "@/flag/flag"
import { Config } from "@/config/config"
import { HolosProfile } from "@/holos/profile"
import { HolosRequest } from "@/holos/request"
import { Log } from "@/util/log"

const log = Log.create({ service: "agora" })

const DEFAULT_AGORA_URL = "https://agora.holosai.io"
const DEFAULT_AGORA_TOKEN_URL = "https://www.holosai.io"
const TOKEN_EXCHANGE_PATH = "/api/v1/holos/agora/agent/token"

interface TokenCache {
  token: string
  expiresAt: number
}

let tokenCache: TokenCache | undefined
let actorRegistered = false

export namespace AgoraClient {
  export interface AgoraConfig {
    url: string
    tokenUrl: string
  }

  export async function getConfig(): Promise<AgoraConfig> {
    const config = await Config.get()
    const agora = config.agora

    const url = Flag.SYNERGY_AGORA_URL ?? agora?.url ?? DEFAULT_AGORA_URL
    const tokenUrl = Flag.SYNERGY_AGORA_TOKEN_URL ?? agora?.tokenUrl ?? DEFAULT_AGORA_TOKEN_URL

    return {
      url: url.replace(/\/+$/, ""),
      tokenUrl: tokenUrl.replace(/\/+$/, ""),
    }
  }

  async function getToken(config: AgoraConfig): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    if (tokenCache && tokenCache.expiresAt > now + 30) {
      return tokenCache.token
    }

    const res = await HolosRequest.fetch(
      `${config.tokenUrl}${TOKEN_EXCHANGE_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      { capability: "agora" },
    )

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to get Agora token (${res.status}): ${text}`)
    }

    const json = await res.json()
    if (json.code !== 0) {
      throw new Error(`Failed to get Agora token: ${json.message}`)
    }

    const { access_token, expires_in } = json.data
    tokenCache = {
      token: access_token,
      expiresAt: now + (expires_in ?? 300),
    }
    log.info("obtained agora token from holos", { expiresIn: expires_in })
    return access_token
  }

  async function registerActor(config: AgoraConfig, token: string): Promise<void> {
    const profile = await HolosProfile.get()
    const displayName = profile?.name || "Synergy Agent"

    const res = await fetch(`${config.url}/api/actors`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        display_name: displayName,
        meta: {},
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to register Agora actor (${res.status}): ${text}`)
    }

    const json = await res.json()
    if (json.code !== 0) {
      throw new Error(`Failed to register Agora actor: ${json.message}`)
    }

    actorRegistered = true
    log.info("registered agora actor", { displayName, actorId: json.data?.id })
  }

  async function executeRequest<T>(
    config: AgoraConfig,
    token: string,
    method: string,
    path: string,
    options?: {
      body?: Record<string, any> | FormData
      params?: Record<string, string | number | undefined>
      abort?: AbortSignal
      timeout?: number
    },
  ): Promise<{ response: Response; timeoutId: ReturnType<typeof setTimeout> }> {
    const url = new URL(`${config.url}${path}`)
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }

    let body: string | FormData | undefined
    if (options?.body) {
      if (options.body instanceof FormData) {
        body = options.body
      } else {
        headers["Content-Type"] = "application/json"
        body = JSON.stringify(options.body)
      }
    }

    const controller = new AbortController()
    const timeoutMs = options?.timeout ?? 30000
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const signals = options?.abort ? AbortSignal.any([controller.signal, options.abort]) : controller.signal

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: signals,
    }).catch((error) => {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Agora request timed out")
      }
      throw error
    })

    return { response, timeoutId }
  }

  export async function request<T = any>(
    method: string,
    path: string,
    options?: {
      body?: Record<string, any> | FormData
      params?: Record<string, string | number | undefined>
      abort?: AbortSignal
      timeout?: number
    },
  ): Promise<T> {
    const config = await getConfig()
    const token = await getToken(config)

    let { response, timeoutId } = await executeRequest(config, token, method, path, options)
    clearTimeout(timeoutId)

    if (response.status === 401 && !actorRegistered) {
      const errorText = await response.text()
      if (errorText.includes("not registered") || errorText.includes("actor")) {
        log.info("actor not registered on agora, auto-registering")
        await registerActor(config, token)
        const retry = await executeRequest(config, token, method, path, options)
        clearTimeout(retry.timeoutId)
        response = retry.response
      } else {
        throw new Error(`Agora API error (${response.status}): ${errorText}`)
      }
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Agora API error (${response.status}): ${errorText}`)
    }

    const json = await response.json()
    if (json.code !== 0) {
      throw new Error(`Agora API error: ${json.message}`)
    }

    return json.data as T
  }

  export function resetAuth() {
    tokenCache = undefined
    actorRegistered = false
  }
}
