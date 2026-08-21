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

async function withManagedToken(fn: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Promise<void>) {
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
    const usesBash = /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)
    if (process.platform === "win32" && !usesBash) {
      await Bun.write(`${tmp.path}/gh.cmd`, "@echo off\r\n<nul set /p dummy=%GH_TOKEN%\r\n")
    } else {
      const ghPath = `${tmp.path}/gh`
      await Bun.write(ghPath, "#!/usr/bin/env bash\nprintf '%s' \"$GH_TOKEN\"")
      await fs.chmod(ghPath, 0o755)
    }
    process.env.PATH = `${tmp.path}${path.delimiter}${savedPath ?? ""}`
    await fn(tmp)
  } finally {
    if (savedGH === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGH
    if (savedGITHUB === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGITHUB
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  }
}

test("local bash injects the managed GH_TOKEN via env for GitHub CLI commands", async () => {
  await withManagedToken(async (tmp) => {
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Plain gh invocation receives the managed token through the child env.
        const ghResult = await LocalBashBackend.execute(
          {
            command: "gh",
            description: "prints managed GitHub token",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(ghResult.output).toBe("stored-gh-token")

        // A non-gh command never sees the token.
        const nonGhResult = await LocalBashBackend.execute(
          {
            command: "printf '%s' \"${GH_TOKEN:-missing}\"",
            description: "prints token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(nonGhResult.output).toBe("missing")
      },
    })
  })
})

test("local bash injects the managed GH_TOKEN for mixed, chained, and piped invocations", async () => {
  await withManagedToken(async (tmp) => {
    const shell = Shell.acceptable()
    const usesBash = /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)
    const usesPosixShell = process.platform !== "win32" || usesBash
    const printTokenOrMissing = usesPosixShell
      ? "printf '%s' \"${GH_TOKEN:-missing}\""
      : "if defined GH_TOKEN (<nul set /p dummy=%GH_TOKEN%) else (<nul set /p dummy=missing)"

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Chained: env injection is visible to every command in the invocation.
        const chainedResult = await LocalBashBackend.execute(
          {
            command: `gh && ${printTokenOrMissing}`,
            description: "prints chained token availability",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(chainedResult.output).toBe("stored-gh-tokenstored-gh-token")

        if (usesPosixShell) {
          // Mixed commands still inject for the gh command.
          const mixedResult = await LocalBashBackend.execute(
            {
              command: "echo ok; gh",
              description: "prints mixed token availability",
              workdir: tmp.path,
            },
            testContext(),
          )
          expect(mixedResult.output).toBe("ok\nstored-gh-token")

          // Piped: the gh process and its peers all inherit the injected env.
          const pipedResult = await LocalBashBackend.execute(
            {
              command: "gh | cat",
              description: "prints piped token availability",
              workdir: tmp.path,
            },
            testContext(),
          )
          expect(pipedResult.output).toBe("stored-gh-token")
        }
      },
    })
  })
})

test("local bash does not override an explicit GH_TOKEN established in the command", async () => {
  await withManagedToken(async (tmp) => {
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Prefix assignment on the gh command itself wins over the injected env.
        const prefixResult = await LocalBashBackend.execute(
          {
            command: "GH_TOKEN=explicit-gh-token gh",
            description: "prints explicit token",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(prefixResult.output).toBe("explicit-gh-token")

        // An export earlier in the invocation also wins over the injected env.
        const exportResult = await LocalBashBackend.execute(
          {
            command: "export GH_TOKEN=exported-gh-token; gh",
            description: "prints exported token",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(exportResult.output).toBe("exported-gh-token")
      },
    })
  })
})

test("local bash adds no output notice when no GitHub credential is connected", async () => {
  const savedGH = process.env.GH_TOKEN
  const savedGITHUB = process.env.GITHUB_TOKEN
  const savedPath = process.env.PATH
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  await Auth.remove(GitHubProvider.PROVIDER_ID).catch(() => {})

  try {
    await using tmp = await tmpdir({ git: true })
    const shell = Shell.acceptable()
    const usesBash = /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)
    if (process.platform === "win32" && !usesBash) {
      await Bun.write(`${tmp.path}/gh.cmd`, "@echo off\r\n@echo gh-ok\r\n")
    } else {
      const ghPath = `${tmp.path}/gh`
      await Bun.write(ghPath, "#!/usr/bin/env bash\nprintf '%s' 'gh-ok'")
      await fs.chmod(ghPath, 0o755)
    }
    process.env.PATH = `${tmp.path}${path.delimiter}${savedPath ?? ""}`

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await LocalBashBackend.execute(
          {
            command: "gh",
            description: "runs gh without a stored credential",
            workdir: tmp.path,
          },
          testContext(),
        )
        expect(result.output).toBe("gh-ok")
        expect(result.output).not.toContain("GitHub CLI token skipped")
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
