import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { openOrganizationService, type OrganizationServiceOptions } from "../../src/service"

const origin = "https://organization.example"
export const password = "correct horse battery staple"

export async function fixture(
  authentication?: OrganizationServiceOptions["authentication"],
  options?: Omit<OrganizationServiceOptions, "home" | "publicOrigin" | "authentication">,
) {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-auth-"))
  const state = {
    home,
    service: await openOrganizationService({ ...options, home, publicOrigin: origin, authentication }).catch(
      async (error: unknown) => {
        await fs.rm(home, { recursive: true, force: true })
        throw error
      },
    ),
  }
  function client() {
    let cookie = ""
    let csrf = ""
    return {
      async request(method: string, route: string, body?: unknown, headers?: Record<string, string>) {
        return state.service.fetch(
          new Request(`${origin}/org/v1${route}`, {
            method,
            headers: { "content-type": "application/json", origin, cookie, "x-csrf-token": csrf, ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
      },
      async login(loginName: string, secret = password) {
        const response = await this.request("POST", "/auth/login", { loginName, password: secret })
        expect(response.status).toBe(200)
        cookie = response.headers.get("set-cookie")!.split(";")[0]
        const result = (await response.json()) as { csrfToken: string }
        csrf = result.csrfToken
        return response
      },
    }
  }
  async function initialize(loginName = "owner") {
    const token = await state.service.bootstrapToken()
    const owner = client()
    const input = {
      token,
      requestID: crypto.randomUUID(),
      organizationName: "Test organization",
      loginName,
      displayName: loginName,
      password,
    }
    const response = await owner.request("POST", "/setup/bootstrap", input)
    expect(response.status).toBe(200)
    await owner.login(loginName)
    return owner
  }
  return {
    get service() {
      return state.service
    },
    client,
    initialize,
    async [Symbol.asyncDispose]() {
      await state.service.close()
      await fs.rm(home, { recursive: true, force: true })
    },
    async restart() {
      await state.service.close()
      state.service = await openOrganizationService({ ...options, home, publicOrigin: origin, authentication })
    },
  }
}
