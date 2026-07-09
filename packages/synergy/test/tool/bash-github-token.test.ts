import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Auth } from "../../src/provider/api-key"
import { GitHubProvider } from "../../src/provider/github"
import { ScopeContext } from "../../src/scope/context"
import { LocalBashBackend } from "../../src/tool/bash/local"
import { Shell } from "../../src/util/shell"
import { tmpdir } from "../fixture/fixture"

const originalGHToken = process.env.GH_TOKEN
const originalGITHUBToken = process.env.GITHUB_TOKEN
const originalPath = process.env.PATH
const originalShell = process.env.SHELL

async function reset() {
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  if (originalGHToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalGHToken
  if (originalGITHUBToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGITHUBToken
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
  Shell.preferred.reset()
  Shell.acceptable.reset()
}

beforeEach(async () => {
  delete process.env.SHELL
  Shell.preferred.reset()
  Shell.acceptable.reset()
})
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
  // Snapshot env so concurrent oauth-provider tests don't corrupt our state.
  const savedGH = process.env.GH_TOKEN
  const savedGITHUB = process.env.GITHUB_TOKEN
  const savedPath = process.env.PATH
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "stored-gh-token" })

  try {
    await using tmp = await tmpdir({ git: true })
    const shell = Shell.acceptable()
    const isUnixShell = /(?:^|[\\/])(?:bash|zsh)(?:\.exe)?$/i.test(shell)
    const printTokenOrMissing = isUnixShell
      ? "printf '%s' \"${GH_TOKEN:-missing}\""
      : "if defined GH_TOKEN (<nul set /p dummy=%GH_TOKEN%) else (<nul set /p dummy=missing)"
    const chainedTokenCommand = `gh && ${printTokenOrMissing}`

    if (isUnixShell) {
      const ghPath = `${tmp.path}/gh`
      await Bun.write(ghPath, "#!/usr/bin/env bash\nprintf '%s' \"$GH_TOKEN\"")
      await fs.chmod(ghPath, 0o755)
    } else {
      await Bun.write(`${tmp.path}/gh.cmd`, "@echo off\r\n<nul set /p dummy=%GH_TOKEN%\r\n")
    }
    process.env.PATH = `${tmp.path}${path.delimiter}${originalPath ?? ""}`
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
            command: printTokenOrMissing,
            description: "prints token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(nonGhResult.output).toBe("missing")

        const chainedResult = await LocalBashBackend.execute(
          {
            command: chainedTokenCommand,
            description: "prints chained token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(chainedResult.output).toBe("missing")
      },
    })
  } finally {
    if (savedGH === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGH
    if (savedGITHUB === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGITHUB
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  }
})
