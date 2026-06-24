import { describe, expect, test } from "bun:test"
import { StartupReporter } from "../../src/cli/startup-reporter"

describe("StartupReporter rendering", () => {
  test("renders a refined boxed panel in fancy mode", () => {
    const output = StartupReporter.render(
      {
        title: "Synergy local",
        rows: [
          { label: "Scope", value: "/workspace" },
          { label: "Server", value: "http://localhost:4096" },
        ],
        statuses: [
          { label: "Data", value: "9 migration domains current", kind: "success" },
          { label: "Plugins", value: "synergy-frontend-kit cached", kind: "success" },
        ],
        next: ["synergy web --dev", 'synergy send "your message"'],
      },
      { fancy: true, color: true, width: 88 },
    )

    const plain = StartupReporter.stripAnsi(output)
    expect(plain).toContain("╭")
    expect(plain).toContain("Synergy local")
    expect(plain).toContain("Scope")
    expect(plain).toContain("http://localhost:4096")
    expect(plain).toContain("✓ Data")
    expect(plain).toContain("Next: synergy web --dev")
  })

  test("renders plain output without ansi for non-fancy surfaces", () => {
    const output = StartupReporter.render(
      {
        title: "Synergy local",
        rows: [{ label: "Server", value: "http://localhost:4096" }],
        statuses: [{ label: "Holos", value: "disabled", kind: "muted" }],
        notes: ["No AI model configured"],
      },
      { fancy: false, color: false, width: 80 },
    )

    expect(output).not.toContain("\x1b[")
    expect(output).not.toContain("╭")
    expect(output).toContain("Synergy local")
    expect(output).toContain("  Server: http://localhost:4096")
    expect(output).toContain("  - Holos: disabled")
    expect(output).toContain("  ! No AI model configured")
  })
})
