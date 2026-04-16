import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyCLIBackend } from "../src/cli-backend"
import { MetaSynergyHolosAuth } from "../src/holos/auth"
import { MetaSynergyStore } from "../src/state/store"

const originalMetaHome = process.env.META_SYNERGY_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const originalFetch = globalThis.fetch
const tempRoots: string[] = []

beforeEach(async () => {
  const metaRoot = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-cli-auth-meta-"))
  const synergyHome = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-cli-auth-synergy-"))
  tempRoots.push(metaRoot, synergyHome)
  process.env.META_SYNERGY_HOME = metaRoot
  process.env.SYNERGY_TEST_HOME = synergyHome
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 0, data: { ws_token: "token", expires_in: 60 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (originalMetaHome === undefined) delete process.env.META_SYNERGY_HOME
  else process.env.META_SYNERGY_HOME = originalMetaHome

  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("meta-synergy cli backend auth payloads", () => {
  test("whoami reports shared auth source", async () => {
    const sharedPath = MetaSynergyHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify({ holos: { type: "holos", agentId: "agent_shared", agentSecret: "secret_shared" } }, null, 2),
    )

    const result = await MetaSynergyCLIBackend.whoami()
    expect(result.auth).toEqual({
      loggedIn: true,
      agentID: "agent_shared",
      source: "shared",
    })
  })

  test("doctor reports migrated legacy auth source in payload and checks", async () => {
    await MetaSynergyStore.saveLegacyAuth({ agentID: "agent_legacy", agentSecret: "secret_legacy" })

    const result = await MetaSynergyCLIBackend.doctor()
    expect(result.auth).toEqual({
      loggedIn: true,
      agentID: "agent_legacy",
      source: "legacy-migrated",
    })
    expect(result.checks.find((check) => check.name === "auth")).toEqual({
      name: "auth",
      ok: true,
      detail: "agent agent_legacy (legacy-migrated)",
    })
  })

  test("logout clears auth and reports logged-out source state", async () => {
    await MetaSynergyStore.saveLegacyAuth({ agentID: "agent_clear", agentSecret: "secret_clear" })
    await MetaSynergyHolosAuth.save({ agentID: "agent_clear", agentSecret: "secret_clear" })

    const result = await MetaSynergyCLIBackend.logout()
    expect(result.authCleared).toBe(true)

    const whoami = await MetaSynergyCLIBackend.whoami()
    expect(whoami.auth).toEqual({
      loggedIn: false,
      agentID: null,
      source: null,
    })
  })
})
