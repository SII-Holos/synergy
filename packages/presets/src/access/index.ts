export namespace Access {
  export interface Descriptor {
    attachUrl: string
  }

  export function normalizeUrl(value: string) {
    return value.replace(/\/+$/, "")
  }

  export function fromServerUrl(serverUrl: string): Descriptor {
    const attachUrl = normalizeUrl(serverUrl)
    return {
      attachUrl,
    }
  }

  export function frontendEnv(serverUrl: string) {
    const descriptor = fromServerUrl(serverUrl)
    return {
      VITE_SYNERGY_SERVER_URL: descriptor.attachUrl,
    }
  }
}
