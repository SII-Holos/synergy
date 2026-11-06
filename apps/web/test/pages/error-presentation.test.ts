import { describe, expect, test } from "bun:test"
import { createFatalErrorPresentation } from "../../src/pages/error-presentation"

function rendererError() {
  const cause = new Error("Session timeline was unavailable")
  cause.stack = "Error: Session timeline was unavailable\n    at readTimeline"
  const error = new TypeError("Could not render the session")
  error.stack = "TypeError: Could not render the session\n    at SessionPage"
  error.cause = cause
  return error
}

describe("fatal error presentation", () => {
  test("keeps renderer diagnostics while only guaranteeing reload behavior", () => {
    let reloads = 0
    const presentation = createFatalErrorPresentation({
      source: "renderer",
      error: rendererError(),
      onRecover: () => reloads++,
    })

    expect(presentation).toMatchObject({
      source: "renderer",
      title: "renderer",
      description: "renderer",
      impact: "reload-interface-only",
      primaryAction: { label: "reload-interface" },
    })
    expect(presentation.details).toContain("TypeError: Could not render the session")
    expect(presentation.details).toContain("Caused by:")
    expect(presentation.details).toContain("Error: Session timeline was unavailable")

    presentation.primaryAction.run()
    expect(reloads).toBe(1)
  })

  test("preserves configuration diagnostics for disclosure without a task-safety claim", () => {
    let retries = 0
    const presentation = createFatalErrorPresentation({
      source: "initialization",
      error: {
        name: "ConfigInvalidError",
        data: {
          path: "/config/synergy.d/10-models.jsonc",
          issues: [{ message: "Expected a provider ID", path: ["models", "default"] }],
        },
      },
      onRecover: () => retries++,
    })

    expect(presentation.source).toBe("initialization")
    expect(presentation.title).toBe("initialization")
    expect(presentation.description).toBeUndefined()
    expect(presentation.impact).toBeUndefined()
    expect(presentation.primaryAction.label).toBe("try-again")
    expect(presentation.details).toContain("Config file at /config/synergy.d/10-models.jsonc is invalid")
    expect(presentation.details).toContain("Expected a provider ID models.default")
    expect(presentation.details).toContain("ConfigInvalidError")

    presentation.primaryAction.run()
    expect(retries).toBe(1)
  })

  test("distinguishes scope recovery from application initialization", () => {
    const presentation = createFatalErrorPresentation({
      source: "scope",
      error: new Error("Scope bootstrap returned no data"),
      onRecover: () => {},
    })

    expect(presentation).toMatchObject({
      source: "scope",
      title: "scope",
      primaryAction: { label: "try-again" },
    })
    expect(presentation.impact).toBeUndefined()
    expect(presentation.details).toContain("Error: Scope bootstrap returned no data")
    expect(presentation.description).toBeUndefined()
  })

  test("treats a lost server as unknown task state with connection recovery actions", () => {
    let retries = 0
    let serverChanges = 0
    const presentation = createFatalErrorPresentation({
      source: "connection",
      error: new Error("Could not connect to server at http://localhost:4096"),
      onRecover: () => retries++,
      onSecondaryAction: () => serverChanges++,
    })

    expect(presentation).toMatchObject({
      source: "connection",
      title: "connection",
      description: "connection",
      primaryAction: { label: "try-again" },
      secondaryAction: { label: "change-server" },
    })
    expect(presentation.impact).toBeUndefined()
    expect(presentation.details).toContain("Error: Could not connect to server at http://localhost:4096")

    presentation.primaryAction.run()
    presentation.secondaryAction?.run()
    expect(retries).toBe(1)
    expect(serverChanges).toBe(1)
  })
})
