import { describe, expect, test } from "bun:test"
import { buildCodexProcessEnv, normalizeCodexSandbox } from "../../src/external-agent/adapter/codex"
import { ExternalAgent } from "../../src/external-agent/bridge"

describe("Codex external adapter environment", () => {
  test("builds an allowlisted process env and preserves explicit Codex API key", () => {
    const env = buildCodexProcessEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/test",
        USER: "zeyi",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "process-secret",
        ANTHROPIC_API_KEY: "process-secret",
        RANDOM_TOKEN: "process-secret",
      },
      { SYNERGY_CODEX_API_KEY: "override-key" },
      { HTTP_PROXY: "http://127.0.0.1:7897", OPENAI_API_KEY: "config-secret" },
    )

    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/test")
    expect(env.USER).toBe("zeyi")
    expect(env.LANG).toBe("en_US.UTF-8")
    expect(env.SYNERGY_CODEX_API_KEY).toBe("override-key")
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897")

    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.RANDOM_TOKEN).toBeUndefined()
  })

  test("only allows safe adapter-configured env keys", () => {
    const env = buildCodexProcessEnv(
      {},
      {},
      {
        HTTPS_PROXY: "http://127.0.0.1:7897",
        ALL_PROXY: "socks5://127.0.0.1:7897",
        SSL_CERT_FILE: "/tmp/ca.pem",
        OPENAI_API_KEY: "config-secret",
        AWS_SECRET_ACCESS_KEY: "config-secret",
      },
    )

    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897")
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:7897")
    expect(env.SSL_CERT_FILE).toBe("/tmp/ca.pem")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })
})

describe("Codex external adapter sandbox normalization", () => {
  test("allows safe sandbox modes", () => {
    expect(normalizeCodexSandbox("read-only")).toBe("read-only")
    expect(normalizeCodexSandbox("workspace-write")).toBe("workspace-write")
  })

  test("rejects dangerous or unknown sandbox modes", () => {
    expect(normalizeCodexSandbox("danger-full-access")).toBeUndefined()
    expect(normalizeCodexSandbox("dangerously-bypass-sandbox")).toBeUndefined()
    expect(normalizeCodexSandbox("none")).toBeUndefined()
    expect(normalizeCodexSandbox("read-write")).toBeUndefined()
    expect(normalizeCodexSandbox(123)).toBeUndefined()
    expect(normalizeCodexSandbox(undefined)).toBeUndefined()
  })
})

describe("Codex external adapter CLI args", () => {
  test("does not let sandbox config bypass controlProfile", async () => {
    const adapter = ExternalAgent.getAdapter("codex", `codex-test-${Date.now()}-sandbox`) as any
    await adapter.start({
      cwd: "/tmp/synergy-test",
      config: { controlProfile: "guarded", sandbox: "danger-full-access" },
    })

    const args = adapter.buildArgs({ sessionID: "ses_test", prompt: "hello" }) as string[]
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args).toContain("--sandbox")
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only")
  })

  test("keeps full_access as the only dangerous sandbox bypass", async () => {
    const adapter = ExternalAgent.getAdapter("codex", `codex-test-${Date.now()}-full-access`) as any
    await adapter.start({
      cwd: "/tmp/synergy-test",
      config: { controlProfile: "full_access", sandbox: "workspace-write" },
    })

    const args = adapter.buildArgs({ sessionID: "ses_test", prompt: "hello" }) as string[]
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args).not.toContain("--sandbox")
  })
})
