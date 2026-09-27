import type { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"

export interface ExecutorConnection {
  url: string | URL
  target: EnvironmentSchema.Target
  token: string
  unix?: string
  tls?: Bun.TLSOptions
}

export class ExecutionConnection {
  constructor(private readonly connection: ExecutorConnection) {}
  async send(method: string, route: string, body?: unknown, binary = false) {
    const response = await fetch(new URL(route, this.connection.url), {
      method,
      unix: this.connection.unix,
      tls: this.connection.tls,
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        "x-synergy-target": JSON.stringify(this.connection.target),
        "content-type": binary ? "application/octet-stream" : "application/json",
      },
      body:
        body === undefined
          ? undefined
          : binary && body instanceof Uint8Array
            ? new Uint8Array(body)
            : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
    if (response.status === 404) return undefined
    if (!response.ok) {
      const reader = response.body?.getReader()
      const first = await reader?.read()
      await reader?.cancel()
      throw new Error(
        `Executor request failed (${response.status}): ${first?.value ? new TextDecoder().decode(first.value.subarray(0, 1024)) : ""}`,
      )
    }
    return response
  }
  async json(method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await this.send(method, route, body)
    return response?.json()
  }
}
