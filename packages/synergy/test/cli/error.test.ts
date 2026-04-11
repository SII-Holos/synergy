import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { FormatError } from "../../src/cli/error"

describe("FormatError", () => {
  test("summarizes JSONC parse errors without dumping full input wrapper", () => {
    const error = new Config.JsonError({
      path: "/tmp/synergy.jsonc",
      message: "\n--- JSONC Input ---\n{ bad json }\n--- Errors ---\nUnexpected token at line 1, column 3\n--- End ---",
    })

    expect(FormatError(error)).toBe(
      [
        "Config file at /tmp/synergy.jsonc is not valid JSON(C).",
        "Unexpected token at line 1, column 3",
        "Tip: fix the config syntax or move the invalid file aside, then rerun the command.",
      ].join("\n"),
    )
  })

  test("falls back to the original JSON error message when no extracted error section exists", () => {
    const error = new Config.JsonError({
      path: "/tmp/synergy.jsonc",
      message: "Unexpected token near provider block",
    })

    expect(FormatError(error)).toBe(
      [
        "Config file at /tmp/synergy.jsonc is not valid JSON(C).",
        "Unexpected token near provider block",
        "Tip: fix the config syntax or move the invalid file aside, then rerun the command.",
      ].join("\n"),
    )
  })

  test("formats invalid config issues with readable paths and upgrade hint", () => {
    const error = new Config.InvalidError({
      path: "/tmp/synergy.jsonc",
      issues: [
        {
          code: "unrecognized_keys",
          keys: ["providers"],
          path: [],
          message: 'Unrecognized key: "providers"',
        },
        {
          code: "invalid_type",
          expected: "string",
          path: ["model"],
          message: "Invalid input: expected string, received number",
        },
      ] as any,
    })

    expect(FormatError(error)).toBe(
      [
        "Configuration is invalid at /tmp/synergy.jsonc",
        '↳ Unrecognized key: "providers"',
        "↳ Invalid input: expected string, received number (model)",
        "Tip: this often happens after upgrading from an older config format. Review the invalid fields and try again.",
      ].join("\n"),
    )
  })
})
