import { describe, expect, test } from "bun:test"
import type { Scope } from "@ericsanchezok/synergy-sdk/client"
import {
  buildImportApplyParameters,
  buildImportPlanParameters,
  formatImportValue,
  isConfigImportRevisionConflict,
  loadImportUrl,
  parseImportText,
  planMatchesSelection,
  projectImportScopes,
} from "../../../../src/components/settings/panels/import-panel-model"

const scopes: Scope[] = [
  {
    id: "home",
    type: "home",
    directory: "/home/user",
    worktree: "/home/user",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
  {
    id: "scope_project",
    type: "project",
    directory: "/workspace/project",
    worktree: "/workspace/project",
    vcs: "git",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
]

describe("config import settings model", () => {
  test("parses pasted JSONC and rejects oversized input before parsing", () => {
    expect(parseImportText('{\n  // comment\n  "username": "Ada",\n}', "pasted")).toEqual({ username: "Ada" })
    expect(() => parseImportText(`{"username":"${"x".repeat(1024 * 1024)}"}`, "large.jsonc")).toThrow(
      "Config source exceeds",
    )
  })

  test("bounds URL sources before and during response streaming", async () => {
    const declared = () =>
      Promise.resolve(
        new Response("{}", {
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
      )
    await expect(loadImportUrl("https://example.test/large.jsonc", declared)).rejects.toThrow("Config source exceeds")

    const streamed = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024))
              controller.enqueue(new Uint8Array([1]))
              controller.close()
            },
          }),
        ),
      )
    await expect(loadImportUrl("https://example.test/stream.jsonc", streamed)).rejects.toThrow("Config source exceeds")
  })

  test("does not follow redirects while loading URL sources", async () => {
    const fetcher = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.redirect).toBe("error")
      return Promise.reject(new Error("redirect blocked"))
    }

    await expect(loadImportUrl("https://example.test/redirect", fetcher)).rejects.toThrow("redirect blocked")
  })

  test("lists project targets without the home scope", () => {
    expect(projectImportScopes(scopes)).toEqual([scopes[1]])
  })

  test("builds explicit global and project plan parameters", () => {
    expect(
      buildImportPlanParameters({
        config: { username: "Ada" },
        source: "pasted",
        scope: "global",
      }),
    ).toMatchObject({
      scopeID: "home",
      configDomainImportPlanInput: { config: { username: "Ada" }, source: "pasted", scope: "global" },
    })

    expect(
      buildImportPlanParameters({
        config: { username: "Ada" },
        source: "settings.jsonc",
        scope: "project",
        project: scopes[1],
        only: ["general"],
      }),
    ).toMatchObject({
      directory: "/workspace/project",
      configDomainImportPlanInput: {
        config: { username: "Ada" },
        source: "settings.jsonc",
        scope: "project",
        only: ["general"],
      },
    })
  })

  test("requires a selected project for project imports", () => {
    expect(() => buildImportPlanParameters({ config: {}, source: "pasted", scope: "project" })).toThrow(
      "Select a project",
    )
  })

  test("applies the reviewed revision and exact domain selection", () => {
    expect(
      buildImportApplyParameters({
        config: { username: "Ada" },
        source: "pasted",
        scope: "project",
        project: scopes[1],
        only: ["general"],
        revision: "revision-1",
      }),
    ).toMatchObject({
      directory: "/workspace/project",
      configDomainImportApplyInput: {
        config: { username: "Ada" },
        source: "pasted",
        scope: "project",
        only: ["general"],
        revision: "revision-1",
        yes: true,
      },
    })
  })

  test("requires a new review when the selected domain set changes", () => {
    const domains = [{ id: "general" as const }, { id: "models" as const }]
    expect(planMatchesSelection(domains, ["general", "models"])).toBe(true)
    expect(planMatchesSelection(domains, ["general"])).toBe(false)
  })

  test("formats absent, scalar, and structured diff values", () => {
    expect(formatImportValue(undefined)).toBe("Not set")
    expect(formatImportValue("provider/model")).toBe("provider/model")
    expect(formatImportValue({ enabled: true })).toBe('{\n  "enabled": true\n}')
  })

  test("recognizes only revision-conflict API errors as stale plans", () => {
    const stale = Object.assign(new Error("Conflict"), {
      name: "APIError",
      data: {
        statusCode: 409,
        responseBody: JSON.stringify({ name: "ConfigImportRevisionConflictError", data: { message: "stale" } }),
      },
    })
    const locked = Object.assign(new Error("Locked"), {
      name: "APIError",
      data: {
        statusCode: 409,
        responseBody: JSON.stringify({ name: "ConfigImportLockedError", data: { message: "locked" } }),
      },
    })

    expect(isConfigImportRevisionConflict(stale)).toBe(true)
    expect(isConfigImportRevisionConflict(locked)).toBe(false)
    expect(isConfigImportRevisionConflict(new Error("Conflict"))).toBe(false)
  })
})
