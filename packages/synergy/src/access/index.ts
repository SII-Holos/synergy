export namespace Access {
  export interface Descriptor {
    attachUrl: string
    callbackUrl: string
  }

  export function normalizeUrl(value: string) {
    return value.replace(/\/+$/, "")
  }

  export function fromServerUrl(serverUrl: string): Descriptor {
    const attachUrl = normalizeUrl(serverUrl)
    return {
      attachUrl,
      callbackUrl: `${attachUrl}/holos/callback`,
    }
  }

  export function frontendEnv(serverUrl: string) {
    const descriptor = fromServerUrl(serverUrl)
    return {
      VITE_SYNERGY_SERVER_URL: descriptor.attachUrl,
      VITE_SYNERGY_CALLBACK_URL: descriptor.callbackUrl,
    }
  }
}
