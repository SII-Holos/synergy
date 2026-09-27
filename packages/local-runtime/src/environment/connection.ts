import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"
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
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const part = await reader?.read()
          if (!part || part.done) break
          length += part.value.length
          if (length > 8 * 1024 * 1024) throw new Error("Executor error response exceeds its size limit")
          chunks.push(part.value)
        }
      } finally {
        await reader?.cancel()
      }
      const message = Buffer.concat(chunks, length).toString()
      const body: unknown = (() => {
        try {
          return JSON.parse(message)
        } catch {
          return undefined
        }
      })()
      const failure = WorkspaceErrors.Failure.safeParse(
        body && typeof body === "object" && "failure" in body ? body.failure : undefined,
      )
      if (failure.success) throw WorkspaceErrors.restore(failure.data)
      throw new Error(`Executor request failed (${response.status}): ${message.slice(0, 1024)}`)
    }
    return response
  }
  async json(method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await this.send(method, route, body)
    return response?.json()
  }
}
