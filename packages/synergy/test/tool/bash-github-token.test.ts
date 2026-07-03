import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import { Auth } from "../../src/provider/api-key"
import { GitHubProvider } from "../../src/provider/github"
import { ScopeContext } from "../../src/scope/context"
import { LocalBashBackend } from "../../src/tool/bash/local"
import { tmpdir } from "../fixture/fixture"

const originalGHToken = process.env.GH_TOKEN
const originalGITHUBToken = process.env.GITHUB_TOKEN
const originalPath = process.env.PATH

async function reset() {
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  if (originalGHToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGHToken
  if (originalGITHUBToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGITHUBToken
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
}

beforeEach(reset)
afterEach(reset)

function testContext() {
  return {
    sessionID: "ses_bash_github_token",
    messageID: "msg_bash_github_token",
    agent: "synergy-max",
    abort: new AbortController().signal,
    extra: { shellBypassSandbox: true },
    metadata() {},
    async ask() {},
  }
}

test("local bash injects stored GH_TOKEN only for GitHub CLI commands", async () => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "stored-gh-token" })

  await using tmp = await tmpdir({ git: true })
  const ghPath = `${tmp.path}/gh`
  await Bun.write(ghPath, "#!/bin/sh\nprintf '%s' \"$GH_TOKEN\"")
  await fs.chmod(ghPath, 0o755)
  process.env.PATH = `${tmp.path}:${originalPath ?? ""}`
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const ghResult = await LocalBashBackend.execute(
        {
          command: "gh",
          description: "prints managed GitHub token",
          workdir: tmp.path,
        },
        testContext(),
      )
      expect(ghResult.output).toBe("stored-gh-token")

      const nonGhResult = await LocalBashBackend.execute(
        {
          command: "printf '%s' \"${GH_TOKEN:-missing}\"",
          description: "prints token availability",
          workdir: tmp.path,
        },
        testContext(),
      )
      expect(nonGhResult.output).toBe("missing")

      const chainedResult = await LocalBashBackend.execute(
        {
          command: "gh && printf '%s' \"${GH_TOKEN:-missing}\"",
          description: "prints chained token availability",
          workdir: tmp.path,
        },
        testContext(),
      )
      expect(chainedResult.output).toBe("missing")
    },
  })
})
