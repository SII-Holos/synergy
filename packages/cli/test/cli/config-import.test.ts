import { describe, expect, test } from "bun:test"
import { ConfigImportCommand } from "../../src/cli/cmd/config"

interface OptionDefinition {
  type?: string
  default?: unknown
  choices?: readonly unknown[]
  alias?: string
}

describe("ConfigImportCommand", () => {
  test("preserves source and exposes scope and stale-plan controls", () => {
    const positionals: Record<string, OptionDefinition> = {}
    const options: Record<string, OptionDefinition> = {}
    const fauxYargs = {
      positional(name: string, definition: OptionDefinition) {
        positionals[name] = definition
        return this
      },
      option(name: string, definition: OptionDefinition) {
        options[name] = definition
        return this
      },
    }

    const builder = ConfigImportCommand.builder
    expect(typeof builder).toBe("function")
    if (typeof builder !== "function") return
    builder(fauxYargs as never)

    expect(positionals.source).toMatchObject({ type: "string" })
    expect(options.scope).toMatchObject({ type: "string", default: "global", choices: ["global", "project"] })
    expect(options.force).toMatchObject({ type: "boolean", default: false })
    expect(options.yes).toMatchObject({ type: "boolean", default: false, alias: "y" })
  })
})
