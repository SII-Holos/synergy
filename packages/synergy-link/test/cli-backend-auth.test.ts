import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkHolosAuth } from "../src/holos/auth"

const originalLinkHome = process.env.SYNERGY_LINK_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const originalFetch = globalThis.fetch
const tempRoots: string[] = []

beforeEach(async () => {
  const linkRoot = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-auth-link-"))
  const synergyHome = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-auth-synergy-"))
  tempRoots.push(linkRoot, synergyHome)
  process.env.SYNERGY_LINK_HOME = linkRoot
  process.env.SYNERGY_TEST_HOME = synergyHome
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 0, data: { ws_token: "token", expires_in: 60 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (originalLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalLinkHome

  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link cli backend auth payloads", () => {
  test("whoami reports shared auth source", async () => {
    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify({ holos: { type: "holos", agentId: "agent_shared", agentSecret: "secret_shared" } }, null, 2),
    )

    const result = await SynergyLinkCLIBackend.whoami()
    expect(result.auth).toEqual({
      loggedIn: true,
      agentID: "agent_shared",
      source: "shared",
      hiddenReason: null,
    })
  })

  test("doctor reports shared auth source in payload and checks", async () => {
    await SynergyLinkHolosAuth.save({ agentID: "agent_shared", agentSecret: "secret_shared" })

    const result = await SynergyLinkCLIBackend.doctor()
    expect(result.auth).toEqual({
      loggedIn: true,
      agentID: "agent_shared",
      source: "shared",
      hiddenReason: null,
    })
    expect(result.checks.find((check) => check.name === "auth")).toEqual({
      name: "auth",
      ok: true,
      detail: "agent agent_shared (shared)",
    })
  })

  test("logout clears shared auth and reports logged-out source state", async () => {
    await SynergyLinkHolosAuth.save({ agentID: "agent_clear", agentSecret: "secret_clear" })

    const result = await SynergyLinkCLIBackend.logout()
    expect(result.authCleared).toBe(true)

    const whoami = await SynergyLinkCLIBackend.whoami()
    expect(whoami.auth).toEqual({
      loggedIn: false,
      agentID: null,
      source: null,
      hiddenReason: null,
    })
  })
})
