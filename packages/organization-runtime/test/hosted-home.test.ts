import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareHostedHome, prepareMemberHome, readRuntimeHome } from "../src/home"
import { memberEnvironment } from "../src/environment"

test("hosted Homes retain an organization machine identity without a human account or personal sources", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-home-"))
  try {
    const input = {
      baseDirectory: directory,
      identity: { orgID: "org", hostID: "team-server" },
      origin: "https://organization.example",
    }
    const hosted = await prepareHostedHome(input)
    expect(await prepareHostedHome(input)).toEqual(hosted)
    expect(await readRuntimeHome(hosted.home, hosted.identity)).toEqual(hosted)
    const member = await prepareMemberHome({
      ...input,
      identity: { orgID: "org", accountID: "team-server", deviceID: "team-server" },
    })
    expect(member.home).not.toBe(hosted.home)
    const selected = memberEnvironment(hosted, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "private",
      SYNERGY_CONFIG_CONTENT: "private",
      HOME: "/private",
    })
    expect(selected.HOME).toBe(hosted.home)
    expect(selected.OPENAI_API_KEY).toBeUndefined()
    expect(selected.SYNERGY_CONFIG_CONTENT).toBeUndefined()
    expect(JSON.parse(selected.SYNERGY_MEMBER_IDENTITY!)).toEqual(hosted.identity)
    await expect(readRuntimeHome(hosted.home, { ...hosted.identity, hostID: "other" })).rejects.toThrow("identity")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
