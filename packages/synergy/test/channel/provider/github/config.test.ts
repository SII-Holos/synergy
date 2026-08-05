import { describe, expect, test } from "bun:test"
import { ChannelGithubAccount, ChannelGithub } from "../../../../src/config/schema"

describe("github channel config — account schema", () => {
  test("applies defaults for optional fields", () => {
    const account = ChannelGithubAccount.parse({
      enabled: true,
      repositories: ["owner/repo"],
      workspaceDir: "github-workspaces",
    })
    expect(account.enabled).toBe(true)
    expect(account.pollingIntervalMs).toBe(300_000)
    expect(account.autoReview).toBe(true)
    expect(account.autoRespond).toBe(true)
    expect(account.agent).toBeUndefined()
  })

  test("accepts explicit overrides", () => {
    const account = ChannelGithubAccount.parse({
      enabled: false,
      repositories: ["a/b", "c/d"],
      workspaceDir: "tmp/github",
      pollingIntervalMs: 600_000,
      autoReview: false,
      autoRespond: false,
      agent: "github-channel-agent",
      model: "openai/gpt-4o",
      variant: "high",
    })
    expect(account.repositories).toEqual(["a/b", "c/d"])
    expect(account.pollingIntervalMs).toBe(600_000)
    expect(account.autoReview).toBe(false)
    expect(account.agent).toBe("github-channel-agent")
  })

  test("rejects invalid repository names", () => {
    expect(() =>
      ChannelGithubAccount.parse({
        repositories: ["not-a-repo"],
        workspaceDir: "w",
      }),
    ).toThrow()
    expect(() =>
      ChannelGithubAccount.parse({
        repositories: ["a/b/c"],
        workspaceDir: "w",
      }),
    ).toThrow()
  })

  test("accepts an empty repository list (channel can be created before repos are added)", () => {
    const account = ChannelGithubAccount.parse({
      repositories: [],
      workspaceDir: "w",
    })
    expect(account.repositories).toEqual([])
  })

  test("defaults repositories to an empty array when omitted", () => {
    const account = ChannelGithubAccount.parse({
      workspaceDir: "w",
    })
    expect(account.repositories).toEqual([])
  })

  test("rejects unknown keys (strict)", () => {
    expect(() =>
      ChannelGithubAccount.parse({
        repositories: ["a/b"],
        workspaceDir: "w",
        unexpected: true,
      }),
    ).toThrow()
  })
})

describe("github channel config — channel schema", () => {
  test("parses a github channel with accounts", () => {
    const channel = ChannelGithub.parse({
      type: "github",
      accounts: {
        default: {
          enabled: true,
          repositories: ["owner/repo"],
          workspaceDir: "github-workspaces",
        },
      },
    })
    expect(channel.type).toBe("github")
    expect(Object.keys(channel.accounts)).toEqual(["default"])
  })

  test("rejects non-github type discriminators", () => {
    expect(() =>
      ChannelGithub.parse({
        type: "feishu",
        accounts: {},
      }),
    ).toThrow()
  })
})
