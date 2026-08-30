import { describe, expect, test } from "bun:test"
import { isEphemeralTestWorktree } from "../../src/utils/ephemeral-test-worktree"

describe("isEphemeralTestWorktree (frontend)", () => {
  test("matches synergy-test-* basenames", () => {
    expect(
      isEphemeralTestWorktree("/private/var/folders/l_/7ssymkds457cy49lqzm23spm0000gn/T/synergy-test-y4xq0p7sllc"),
    ).toBe(true)
    expect(isEphemeralTestWorktree("/var/folders/x/T/synergy-test-abc")).toBe(true)
    expect(isEphemeralTestWorktree("/tmp/synergy-test-foo")).toBe(true)
  })

  test("matches synergy-orchestrated-* basenames", () => {
    expect(isEphemeralTestWorktree("/var/folders/x/T/synergy-orchestrated-123-abc")).toBe(true)
  })

  test("does not match a real project directory named synergy-test", () => {
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy-test")).toBe(false)
  })

  test("does not match a real project under a synergy-test parent", () => {
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy-test/3d-software-rasterizer-pro")).toBe(false)
  })

  test("does not match ordinary project worktrees", () => {
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy/packages/synergy")).toBe(false)
    expect(isEphemeralTestWorktree("/Users/eric/projects/synergy/.synergy/worktrees/x/packages/synergy")).toBe(false)
  })

  test("handles windows-style separators", () => {
    expect(isEphemeralTestWorktree("C:\\Users\\x\\AppData\\Local\\Temp\\synergy-test-abc")).toBe(true)
    expect(isEphemeralTestWorktree("C:\\Users\\x\\projects\\synergy-test\\foo")).toBe(false)
  })
})
