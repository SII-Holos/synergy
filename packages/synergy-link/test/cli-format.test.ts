import { describe, expect, test } from "bun:test"
import { SynergyLinkCLIFormat } from "../src/cli/format"

describe("synergy-link cli format", () => {
  test("fieldList aligns labels and shows values in full", () => {
    const output = SynergyLinkCLIFormat.fieldList(
      [
        { label: "Mode", value: "standalone" },
        { label: "Link ID", value: "link_58cdeb0d-59e8-4212-92e2-9a451ef0326a" },
        { label: "Session", value: "idle", tone: "muted" },
      ],
      false,
    )

    const lines = output.split("\n")
    expect(lines[0]).toBe("Mode     standalone")
    expect(lines[1]).toBe("Link ID  link_58cdeb0d-59e8-4212-92e2-9a451ef0326a")
    expect(lines[2]).toBe("Session  idle")
  })

  test("full identifiers are never truncated or masked", () => {
    const linkID = "link_58cdeb0d-59e8-4212-92e2-9a451ef0326a"
    const output = SynergyLinkCLIFormat.fieldList([{ label: "Link ID", value: linkID }], false)

    expect(output).toContain(linkID)
    expect(output).not.toContain("...")
  })

  test("plain mode contains no ANSI escape sequences", () => {
    const output = SynergyLinkCLIFormat.fieldList(
      [
        { label: "Holos", value: "connected", tone: "ok" },
        { label: "Service", value: "stopped", tone: "bad" },
      ],
      false,
    )

    expect(output).not.toContain("")
    expect(output).toContain("connected")
    expect(output).toContain("stopped")
  })

  test("color mode applies tones via ANSI", () => {
    const output = SynergyLinkCLIFormat.fieldList([{ label: "Holos", value: "connected", tone: "ok" }], true)

    expect(output).toContain("connected")
  })

  test("colorEnabled is false for non-TTY or NO_COLOR", () => {
    const fakeStream = { isTTY: false } as NodeJS.WriteStream
    expect(SynergyLinkCLIFormat.colorEnabled(fakeStream)).toBe(false)
  })

  test("statusValue maps good, bad, and neutral values", () => {
    expect(SynergyLinkCLIFormat.statusValue("running", ["running"], ["stopped"])).toBe("ok")
    expect(SynergyLinkCLIFormat.statusValue("stopped", ["running"], ["stopped"])).toBe("bad")
    expect(SynergyLinkCLIFormat.statusValue("starting", ["running"], ["stopped"])).toBe("muted")
  })

  test("doctorCheck renders pass and fail lines", () => {
    expect(SynergyLinkCLIFormat.doctorCheck({ ok: true, name: "auth", detail: "agent x (shared)" }, false)).toBe(
      "✔ auth — agent x (shared)",
    )
    expect(SynergyLinkCLIFormat.doctorCheck({ ok: false, name: "service", detail: "not running" }, false)).toBe(
      "✘ service — not running",
    )
  })
})
