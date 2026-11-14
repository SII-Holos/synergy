import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationClientAuth as Auth } from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationAccounts } from "../../src/organization/accounts"
import { z } from "zod"

export async function organizationFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-organization-"))
  const home = path.join(root, "service")
  const process = Bun.spawn(
    [Bun.which("bun")!, "--no-env-file", path.join(import.meta.dir, "organization-service.ts"), home],
    {
      env: {
        PATH: globalThis.process.env.PATH,
        SystemRoot: globalThis.process.env.SystemRoot,
        SYNERGY_TEST_HOME: home,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(process.stderr).text()
  const reader = process.stdout.getReader()
  async function cleanup() {
    process.kill("SIGTERM")
    await process.exited
    reader.releaseLock()
    await fs.rm(root, { recursive: true, force: true })
  }
  try {
    const first = await Promise.race([
      reader.read(),
      process.exited.then(async () => {
        throw new Error(`Organization fixture exited: ${await errors}`)
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Organization fixture startup timed out")), 20_000)
        timer.unref()
      }),
    ])
    const info = Auth.Authority.extend({ url: z.url() }).parse(JSON.parse(new TextDecoder().decode(first.value)))
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== info.issuer) throw new Error("Unexpected organization target")
      return fetch(new URL(url.pathname + url.search, info.url), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: "error",
        credentials: "omit",
        body: request.body ? await request.arrayBuffer() : undefined,
      })
    }) as typeof fetch
    const api = createOrganizationClient({ baseUrl: info.issuer, fetch: transport })
    const login = await api.orgAuth.login(
      { orgLoginInput: { loginName: "owner", password: "desktop organization fixture password" } },
      { headers: { origin: info.issuer }, throwOnError: true },
    )
    const headers = {
      origin: info.issuer,
      cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
      "x-csrf-token": login.data.csrfToken,
    }
    const key = randomBytes(32)
    const encryption = {
      available: async () => true,
      encrypt: async (text: string) => {
        const iv = randomBytes(12)
        const cipher = createCipheriv("aes-256-gcm", key, iv)
        const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), data])
      },
      decrypt: async (data: Buffer) => {
        const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12))
        cipher.setAuthTag(data.subarray(12, 28))
        return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8")
      },
    }
    const options = { root: path.join(root, "accounts"), encryption, fetch: transport }
    const accounts = new DesktopOrganizationAccounts(options)
    return {
      root,
      info,
      transport,
      api,
      accounts,
      encryption,
      account: login.data.account,
      restart: () => new DesktopOrganizationAccounts(options),
      async consent(request: Auth.Authorize) {
        const code = await api.orgAuth.authorize({ orgAuthorizeInput: request }, { headers, throwOnError: true })
        return Auth.Code.parse(code.data)
      },
      async [Symbol.asyncDispose]() {
        accounts.dispose()
        await cleanup()
        expect(await process.exited).toBe(0)
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
