import { expect, test } from "bun:test"
import { githubToolVisibility } from "../src/tool-policy"
test("GitHub delivery is available only to a GitHub Channel endpoint", () => {
  expect(githubToolVisibility({ toolName: "github_deliver_fix" })).toMatchObject({
    metadata: { requiredEndpoint: "github" },
  })
  expect(
    githubToolVisibility({
      toolName: "github_deliver_fix",
      session: { endpoint: { kind: "channel", channel: { type: "feishu", accountId: "a", scopeKey: "b" } } },
    }),
  ).toBeDefined()
  expect(
    githubToolVisibility({
      toolName: "github_deliver_fix",
      session: { endpoint: { kind: "channel", channel: { type: "github", accountId: "a", scopeKey: "b" } } },
    }),
  ).toBeUndefined()
  expect(githubToolVisibility({ toolName: "read_file" })).toBeUndefined()
})
