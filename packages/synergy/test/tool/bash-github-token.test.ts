import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Auth } from "../../src/provider/api-key"
import { GitHubProvider } from "../../src/provider/github"
import { ScopeContext } from "../../src/scope/context"
import { LocalBashBackend, injectGitHubTokenPrefixes } from "../../src/tool/bash/local"
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

test("injectGitHubTokenPrefixes prefixes each gh command with a quoted token", () => {
  expect(injectGitHubTokenPrefixes("gh api user", "tok", [{ startIndex: 0 }])).toBe("GH_TOKEN='tok' gh api user")
  expect(injectGitHubTokenPrefixes("echo ok; gh repo view", "tok", [{ startIndex: 9 }])).toBe(
    "echo ok; GH_TOKEN='tok' gh repo view",
  )
  expect(injectGitHubTokenPrefixes("gh api user | head", "tok", [{ startIndex: 0 }])).toBe(
    "GH_TOKEN='tok' gh api user | head",
  )
  expect(injectGitHubTokenPrefixes("gh a | gh b", "tok", [{ startIndex: 0 }, { startIndex: 7 }])).toBe(
    "GH_TOKEN='tok' gh a | GH_TOKEN='tok' gh b",
  )
})

test("injectGitHubTokenPrefixes quotes tokens containing shell metacharacters", () => {
  expect(injectGitHubTokenPrefixes("gh api user", "a'b", [{ startIndex: 0 }])).toBe("GH_TOKEN='a'\"'\"'b' gh api user")
  expect(injectGitHubTokenPrefixes("gh api user", "x y", [{ startIndex: 0 }])).toBe("GH_TOKEN='x y' gh api user")
})

test("local bash injects stored GH_TOKEN for GitHub CLI commands", async () => {
  // Snapshot env so concurrent oauth-provider tests don't corrupt our state.
  const savedGH = process.env.GH_TOKEN
  const savedGITHUB = process.env.GITHUB_TOKEN
  const savedPath = process.env.PATH
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "stored-gh-token" })

  await using tmp = await tmpdir({ git: true })
  const shell = Shell.acceptable()
  const usesBash = /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)
  const usesPosixShell = process.platform !== "win32" || usesBash
  const printTokenOrMissing = usesPosixShell
    ? "printf '%s' \"${GH_TOKEN:-missing}\""
    : "if defined GH_TOKEN (<nul set /p dummy=%GH_TOKEN%) else (<nul set /p dummy=missing)"
  const chainedTokenCommand = `gh && ${printTokenOrMissing}`
  const mixedTokenCommand = `echo ok; gh`
  const pipedTokenCommand = `gh | cat`
  if (process.platform === "win32" && !usesBash) {
    await Bun.write(`${tmp.path}/gh.cmd`, "@echo off\r\n<nul set /p dummy=%GH_TOKEN%\r\n")
  } else {
    const ghPath = `${tmp.path}/gh`
    await Bun.write(ghPath, "#!/usr/bin/env bash\nprintf '%s' \"$GH_TOKEN\"")
    await fs.chmod(ghPath, 0o755)
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

      if (usesPosixShell) {
        // Prefix assignment scopes the token to the gh process itself: gh sees
        // it, the chained printf (a separate command) does not.
        const chainedResult = await LocalBashBackend.execute(
          {
            command: chainedTokenCommand,
            description: "prints chained token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(chainedResult.output).toBe("stored-gh-tokenmissing")

        const mixedResult = await LocalBashBackend.execute(
          {
            command: mixedTokenCommand,
            description: "prints mixed token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(mixedResult.output).toBe("ok\nstored-gh-token")

        const pipedResult = await LocalBashBackend.execute(
          {
            command: pipedTokenCommand,
            description: "prints piped token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(pipedResult.output).toBe("stored-gh-token")
      } else {
        const chainedResult = await LocalBashBackend.execute(
          {
            command: chainedTokenCommand,
            description: "prints chained token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(chainedResult.output).toBe("missing")
      }
    },
  })
})

test("local bash does not override an explicit GH_TOKEN assignment", async () => {
  const savedGH = process.env.GH_TOKEN
  const savedGITHUB = process.env.GITHUB_TOKEN
  const savedPath = process.env.PATH
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})
  await Auth.set(GitHubProvider.PROVIDER_ID, { type: "api", key: "stored-gh-token" })

  await using tmp = await tmpdir({ git: true })
  const shell = Shell.acceptable()
  const usesBash = /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)
  if (process.platform === "win32" && !usesBash) {
    await Bun.write(`${tmp.path}/gh.cmd`, "@echo off\r\n<nul set /p dummy=%GH_TOKEN%\r\n")
  } else {
    const ghPath = `${tmp.path}/gh`
    await Bun.write(ghPath, "#!/usr/bin/env bash\nprintf '%s' \"$GH_TOKEN\"")
    await fs.chmod(ghPath, 0o755)
  }
  process.env.PATH = `${tmp.path}${path.delimiter}${originalPath ?? ""}`
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explicitResult = await LocalBashBackend.execute(
        {
          command: "GH_TOKEN=explicit-gh-token gh",
          description: "prints explicit token",
          workdir: tmp.path,
        },
        testContext(),
      )
      expect(explicitResult.output).toBe("explicit-gh-token")
    },
  })
})
