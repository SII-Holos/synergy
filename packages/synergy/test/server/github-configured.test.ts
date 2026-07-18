import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"

test("GET /github/configured reports only whether both GitHub App credentials are present", async () => {
  const originalAppID = process.env.SYNERGY_GITHUB_APP_ID
  const originalPrivateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY

  try {
    delete process.env.SYNERGY_GITHUB_APP_ID
    delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY

    const missing = await Server.App().request("/github/configured")
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({ configured: false })

    process.env.SYNERGY_GITHUB_APP_ID = "12345"
    process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = "private-key-material"

    const configured = await Server.App().request("/github/configured")
    expect(configured.status).toBe(200)
    const body = await configured.json()
    expect(body).toEqual({ configured: true })
    expect(JSON.stringify(body)).not.toContain("12345")
    expect(JSON.stringify(body)).not.toContain("private-key-material")

    process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = "   "
    const incomplete = await Server.App().request("/github/configured")
    expect(incomplete.status).toBe(200)
    expect(await incomplete.json()).toEqual({ configured: false })
  } finally {
    if (originalAppID === undefined) delete process.env.SYNERGY_GITHUB_APP_ID
    else process.env.SYNERGY_GITHUB_APP_ID = originalAppID
    if (originalPrivateKey === undefined) delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
    else process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = originalPrivateKey
  }
})
