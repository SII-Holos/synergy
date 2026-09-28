import { z } from "zod"

export const DockerContainer = z.object({
  Id: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean(), Status: z.string(), StartedAt: z.string() }),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()),
  }),
})

// Provenance: https://docs.docker.com/reference/api/engine/
// Local adaptation: Docker owns allocation only; command identity and replay belong to the Synergy Executor protocol.
export class DockerEngine {
  private version?: Promise<string>
  constructor(private readonly options: { endpoint: string; tls?: Bun.TLSOptions }) {
    const url = new URL(options.endpoint)
    if (!["unix:", "https:", "http:"].includes(url.protocol)) throw new Error("Unsupported Docker Engine transport")
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Remote Docker Engines require TLS")
  }

  private async apiVersion() {
    return (this.version ??= (async () => {
      const response = await this.send("GET", "/version")
      const version = z
        .object({ ApiVersion: z.string(), MinAPIVersion: z.string().optional() })
        .parse(await response.json())
      if (Number(version.ApiVersion.split(".")[1]) < 45) throw new Error("Docker Engine API 1.45 or newer is required")
      return "v" + version.ApiVersion
    })())
  }

  async request(method: string, route: string, body?: unknown, allowed: number[] = []) {
    return this.send(method, `/${await this.apiVersion()}${route}`, body, allowed)
  }

  private async send(method: string, route: string, body?: unknown, allowed: number[] = []) {
    const endpoint = new URL(this.options.endpoint)
    const unix = endpoint.protocol === "unix:" ? decodeURIComponent(endpoint.pathname) : undefined
    const response = await fetch(new URL(route, unix ? "http://docker" : endpoint), {
      method,
      unix,
      tls: this.options.tls,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    })
    if (!response.ok && !allowed.includes(response.status))
      throw new Error(`Docker Engine request failed (${response.status}) for ${method} ${route.split("?")[0]}`)
    return response
  }

  async inspect(name: string) {
    const response = await this.request("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, [404])
    return response.status === 404 ? undefined : DockerContainer.parse(await response.json())
  }
}
