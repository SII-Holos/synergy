import { describe, expect, test } from "bun:test"

// Import the module that must be created at packages/synergy/src/conflict/detect.ts
// Named export: detectConflicts(content: string): ConflictReport
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ConflictLocation {
  /** 1-based line number of the <<<<<<< line */
  startLine: number
  /** 1-based line number of the ======= line */
  separatorLine: number
  /** 1-based line number of the >>>>>>> line */
  endLine: number
}

interface ConflictReport {
  hasConflicts: boolean
  conflicts: ConflictLocation[]
}

// Dynamic import so the test file compiles before the module exists.
// The module at src/conflict/detect.ts must export { detectConflicts }.
async function detectConflicts(content: string): Promise<ConflictReport> {
  const mod = await import("../../src/conflict/detect")
  return mod.detectConflicts(content)
}

describe("conflict.detectConflicts", () => {
  describe("standard git conflict groups", () => {
    test("detects a single conflict block with standard markers", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `line before
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> main
line after
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(1)
      expect(report.conflicts[0]).toMatchObject({
        startLine: 2,
        separatorLine: 4,
        endLine: 6,
      })
    })

    test("detects multiple conflict blocks in the same file", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< ours
a
=======
b
>>>>>>> theirs
middle
<<<<<<< HEAD
x
=======
y
>>>>>>> other
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(2)
      expect(report.conflicts[0].startLine).toBe(1)
      expect(report.conflicts[0].separatorLine).toBe(3)
      expect(report.conflicts[0].endLine).toBe(5)
      expect(report.conflicts[1].startLine).toBe(7)
      expect(report.conflicts[1].separatorLine).toBe(9)
      expect(report.conflicts[1].endLine).toBe(11)
    })

    test("detects conflict with arbitrary branch names after markers", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< feature/my-branch
local change
=======
remote change
>>>>>>> origin/feature/my-branch
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(1)
    })

    test("detects conflict when separator line has trailing whitespace", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< HEAD
a
=======  
b
>>>>>>> main
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(1)
    })

    test("detects conflict when end marker has no trailing branch name", async () => {
      // (some conflict styles produce bare >>>>>>>)
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< HEAD
a
=======
b
>>>>>>>
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(1)
    })
  })

  describe("false positive avoidance", () => {
    test("returns no conflicts for regular source code", async () => {
      const content = `export function foo() {
  const x = 1
  const y = 2
  return x + y
}
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(false)
      expect(report.conflicts).toHaveLength(0)
    })

    test("returns no conflicts when only a start marker is present", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `line 1
<<<<<<< HEAD
line 3 but no separator or end marker
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(false)
    })

    test("returns no conflicts when separator appears without start marker", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `line 1
=======
line 3
>>>>>>> main
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(false)
    })

    test("returns no conflicts when markers are out of order (end before separator)", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< HEAD
a
>>>>>>> main
=======
b
>>>>>>> main
`
      const report = await detectConflicts(content)
      // The first group is malformed: end before separator. Should not be detected.
      expect(report.conflicts).toHaveLength(0)
    })

    test("returns no conflicts when start marker is indented (not at line start)", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `  <<<<<<< HEAD
a
=======
b
>>>>>>> main
`
      const report = await detectConflicts(content)
      // Indented markers are not actual git conflict markers — they may appear in docs
      expect(report.hasConflicts).toBe(false)
    })

    test("returns no conflicts for lines that contain ====== but are not pure separators", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `header
=======something
footer
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(false)
    })

    test("returns no conflicts for docstring examples of conflict markers", async () => {
      // A file documenting conflict syntax should not trigger detection
      // because the markers are in content, not active conflicts.
      // This is already covered by requiring ordered groups, but we
      // add an explicit test for a realistic docstring pattern.
      // eslint-disable-next-line no-irregular-whitespace
      const content = `/**
 * Example conflict:
 *   <<<<<<< HEAD
 *   our change
 *   =======
 *   their change
 *   >>>>>>> branch
 */
export const version = 1
`
      const report = await detectConflicts(content)
      // Markers prefixed with * and whitespace are not at line starts
      expect(report.hasConflicts).toBe(false)
    })
  })

  describe("edge cases", () => {
    test("returns no conflicts for empty content", async () => {
      const report = await detectConflicts("")
      expect(report.hasConflicts).toBe(false)
      expect(report.conflicts).toHaveLength(0)
    })

    test("handles content with only newlines", async () => {
      const report = await detectConflicts("\n\n\n")
      expect(report.hasConflicts).toBe(false)
    })

    test("conflict at very start of file with no preceding lines", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `<<<<<<< HEAD
ours
=======
theirs
>>>>>>> main
`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts[0].startLine).toBe(1)
    })

    test("conflict at very end of file with no trailing lines", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `header
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> main`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
    })

    test("handles CRLF line endings", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `before\r\n<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> main\r\nafter\r\n`
      const report = await detectConflicts(content)
      expect(report.hasConflicts).toBe(true)
      expect(report.conflicts).toHaveLength(1)
    })
  })
})
