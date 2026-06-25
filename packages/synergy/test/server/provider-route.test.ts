import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Auth } from "../../src/provider/api-key"
import { CodexProvider } from "../../src/provider/codex"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"

const originalCodexHome = process.env.CODEX_HOME

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function makeJWT(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

function accessToken() {
  return makeJWT({
    exp: nowSeconds() + 60 * 60,
    "https://api.openai.com/auth.chatgpt_account_id": "acct_provider_route",
  })
}

async function reset() {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  await Auth.remove(CodexProvider.PROVIDER_ID).catch(() => {})
  await Provider.reload()
}

beforeEach(reset)
afterEach(reset)

test("/provider returns catalog, auth health, and runtime availability", async () => {
  const app = Server.App()
  const response = await app.request("/provider")
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body.all.some((provider: any) => provider.id === CodexProvider.PROVIDER_ID)).toBe(true)
  expect(body.catalogProviders).toContain(CodexProvider.PROVIDER_ID)
  expect(body.authHealth[CodexProvider.PROVIDER_ID]).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    status: "not_configured",
  })
  expect(body.runtimeAvailability[CodexProvider.PROVIDER_ID]).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    available: false,
    reason: "not_connected",
  })
})

test("/provider/auth exposes Codex OAuth and import methods", async () => {
  const app = Server.App()
  const response = await app.request("/provider/auth")
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body[CodexProvider.PROVIDER_ID]).toEqual([
    { type: "oauth", label: "Login with ChatGPT" },
    { type: "import", label: "Import Codex CLI credentials" },
  ])
})

test("/provider/:providerID/import imports local Codex CLI credentials", async () => {
  const token = accessToken()
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: token,
            refresh_token: "refresh-provider-route",
          },
        }),
      )
    },
  })
  process.env.CODEX_HOME = tmp.path

  const app = Server.App()
  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: 1 }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toBe(true)
  expect(await Auth.get(CodexProvider.PROVIDER_ID)).toMatchObject({
    type: "oauth",
    access: token,
    refresh: "refresh-provider-route",
  })
})

test("/provider/:providerID/usage returns typed unavailable when disconnected", async () => {
  const app = Server.App()
  const response = await app.request(`/provider/${CodexProvider.PROVIDER_ID}/usage`)
  expect(response.status).toBe(200)
  const body = await response.json()

  expect(body).toMatchObject({
    providerID: CodexProvider.PROVIDER_ID,
    status: "unavailable",
    reloginRequired: true,
  })
})
