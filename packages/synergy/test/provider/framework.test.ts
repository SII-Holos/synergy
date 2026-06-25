import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Auth } from "../../src/provider/api-key"
import { AnthropicOAuthProvider } from "../../src/provider/anthropic-oauth"
import { ProviderCatalog } from "../../src/provider/catalog"
import { CodexProvider } from "../../src/provider/codex"
import { AccountUsage } from "../../src/provider/usage"

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
    "https://api.openai.com/auth.chatgpt_account_id": "acct_usage",
  })
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  })
}

function asFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return fn as unknown as typeof fetch
}

async function cleanupAuth() {
  for (const provider of ["openai-codex", "anthropic", "openrouter"]) {
    await Auth.remove(provider).catch(() => {})
  }
  await fs.rm(Global.Path.authApiKey, { force: true }).catch(() => {})
  await fs.rm(`${Global.Path.authApiKey}.bak`, { force: true }).catch(() => {})
}

afterEach(async () => {
  ProviderCatalog.reset()
  await cleanupAuth()
})

test("provider catalog supplies subscription providers missing from models.dev", async () => {
  const catalog = await ProviderCatalog.resolve({ forceRefresh: true })

  expect(catalog["openai-codex"]).toBeDefined()
  expect(catalog["openai-codex"].models["gpt-5.4-mini"]).toBeDefined()
  expect(catalog["minimax-oauth"]).toBeDefined()
  expect(catalog["qwen-oauth"]).toBeDefined()
  expect(catalog["github-copilot"]).toBeDefined()
})

test("provider auth store migrates legacy api-key.json into v2 store", async () => {
  await cleanupAuth()
  await Bun.write(
    Global.Path.authApiKey,
    JSON.stringify({
      anthropic: { type: "api", key: "sk-ant-test" },
      "openai-codex": {
        type: "oauth",
        access: accessToken(),
        refresh: "refresh-test",
        expires: nowSeconds() + 3600,
      },
    }),
  )
  await fs.chmod(Global.Path.authApiKey, 0o600)

  const result = await Auth.migrateLegacy()
  const all = await Auth.all()
  const stat = await fs.stat(Global.Path.authProvider)

  expect(result).toEqual({ migrated: true, count: 2 })
  expect(all.anthropic).toEqual({ type: "api", key: "sk-ant-test" })
  expect(all["openai-codex"]?.type).toBe("oauth")
  expect(stat.mode & 0o777).toBe(0o600)
  expect(await Bun.file(`${Global.Path.authApiKey}.bak`).exists()).toBe(true)
})

test("codex usage parser returns session and weekly quota windows", async () => {
  await Auth.set("openai-codex", {
    type: "oauth",
    access: accessToken(),
    refresh: "refresh-test",
    expires: nowSeconds() + 3600,
  })

  const snapshot = await CodexProvider.fetchUsage(async (input, init) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toContain("Bearer ")
    expect(headers.get("chatgpt-account-id")).toBe("acct_usage")
    return jsonResponse({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: "2026-06-25T10:00:00Z" },
        secondary_window: { used_percent: 75, reset_at: "2026-06-29T10:00:00Z" },
      },
      credits: { has_credits: true, balance: 12.5 },
    })
  })

  expect(snapshot.status).toBe("available")
  expect(snapshot.windows.map((window) => [window.label, window.usedPercent, window.remainingPercent])).toEqual([
    ["Session", 25, 75],
    ["Weekly", 75, 25],
  ])
  expect(snapshot.details).toContain("Credits balance: $12.50")
})

test("anthropic oauth usage parser returns claude quota windows", async () => {
  await Auth.set("anthropic", {
    type: "oauth",
    access: "anthropic-access",
    refresh: "anthropic-refresh",
    expires: nowSeconds() + 3600,
  })

  const snapshot = await AnthropicOAuthProvider.fetchUsage(async (input, init) => {
    expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer anthropic-access")
    return jsonResponse({
      five_hour: { utilization: 0.5, resets_at: "2026-06-25T10:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-06-29T10:00:00Z" },
      extra_usage: { is_enabled: true, used_credits: 2, monthly_limit: 10, currency: "USD" },
    })
  })

  expect(snapshot.windows.map((window) => [window.label, window.usedPercent, window.remainingPercent])).toEqual([
    ["Current session", 50, 50],
    ["Current week", 80, 20],
  ])
  expect(snapshot.details).toContain("Extra usage: 2.00 / 10.00 USD")
})

test("openrouter usage parser returns credit balance", async () => {
  await Auth.set("openrouter", { type: "api", key: "sk-or-test" })

  const snapshot = await AccountUsage.openrouter(
    "openrouter",
    asFetch(async (input) => {
      if (String(input).endsWith("/credits")) {
        return jsonResponse({ data: { total_credits: 20, total_usage: 7.5 } })
      }
      return jsonResponse({ data: { limit: 10, limit_remaining: 4, usage: 6 } })
    }),
  )

  expect(snapshot.status).toBe("available")
  expect(snapshot.credits?.balance).toBe(12.5)
  expect(snapshot.credits?.currency).toBe("USD")
  expect(snapshot.details).toContain("Credits balance: $12.50")
  expect(snapshot.windows[0]?.usedPercent).toBe(60)
  expect(snapshot.windows[0]?.remainingPercent).toBe(40)
})
