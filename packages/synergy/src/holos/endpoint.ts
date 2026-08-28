import { Config } from "@/config/config"
import { HOLOS_PORTAL_URL, HOLOS_URL, HOLOS_WS_URL } from "./constants"

export namespace HolosEndpoint {
  export type Info = {
    apiUrl: string
    wsUrl: string
    portalUrl: string
  }

  export const defaults: Info = {
    apiUrl: HOLOS_URL,
    wsUrl: HOLOS_WS_URL,
    portalUrl: HOLOS_PORTAL_URL,
  }
  export async function resolve(): Promise<Info> {
    const config = await Config.globalResolved().catch(() => undefined)
    return {
      apiUrl: config?.holos?.apiUrl ?? defaults.apiUrl,
      wsUrl: config?.holos?.wsUrl ?? defaults.wsUrl,
      portalUrl: config?.holos?.portalUrl ?? defaults.portalUrl,
    }
  }

  export function url(route: string, baseUrl: string): string {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    return new URL(route.replace(/^\//, ""), normalizedBase).toString()
  }
}
