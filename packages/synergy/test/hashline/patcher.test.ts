import { describe, expect, test } from "bun:test"
import {
  computeFileHash,
  formatHashlineHeader,
  HEADTAIL_DRIFT_WARNING,
  InMemoryFilesystem,
  InMemorySnapshotStore,
  MismatchError,
  Patch,
  Patcher,
  type PatcherOptions,
} from "../../src/hashline/index"

const PATH = "a.ts"

// ============================================================================
// Patcher snapshot tag integrity
// ============================================================================
describe("Patcher snapshot tag integrity", () => {
  test("requires a snapshot store at construction", () => {
    const fs = new InMemoryFilesystem()
    expect(() => new Patcher({ fs } as unknown as PatcherOptions)).toThrow(/requires a SnapshotStore/)
  })

  test("applies when the section tag is the live file's content hash", async () => {
    const content = "line1\nline2\nline3\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    const fileHash = computeFileHash(content)
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 1.=2:\n+new1\n+new2\n`)
    const result = await patcher.apply(patch)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].op).toBe("update")
    expect(result.sections[0].after).toBe("new1\nnew2\nline3\n")
  })

  test("validates any anchor purely from the content hash, even with no recorded snapshot", async () => {
    const content = "a\nb\nc\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    // No snapshot recorded in store — but live content hashes to the tag
    const fileHash = computeFileHash(content)
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 1.=1:\n+X\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })

  test("refuses with mismatch when the recorded version no longer matches live content", async () => {
    const fs = new InMemoryFilesystem([[PATH, "drifted\n"]])
    const snapshots = new InMemorySnapshotStore()
    const originalContent = "before\n"
    const staleTag = snapshots.record(PATH, originalContent)
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${staleTag}]\nSWAP 1.=1:\n+changed\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(MismatchError)
  })

  test("refuses with a 'not from this session' diagnostic when the tag was never recorded", async () => {
    const content = "live\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    const patcher = new Patcher({ fs, snapshots })

    // Bogus tag never recorded
    const patch = Patch.parse(`[${PATH}#AAAA]\nSWAP 1.=1:\n+new\n`)
    try {
      await patcher.apply(patch)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(MismatchError)
      if (err instanceof MismatchError) {
        expect(err.hashRecognized).toBe(false)
        expect(err.message).toContain("not from this session")
      }
    }
  })
})

// ============================================================================
// Patcher mandatory snapshot tag policy
// ============================================================================
describe("Patcher mandatory snapshot tag policy", () => {
  test("rejects a hashless head/tail insert — the tag is required on every section", async () => {
    const content = "line1\nline2\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}]\nINS.HEAD:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(/Missing hashline snapshot tag/)
  })

  test("still hard-rejects an anchored edit that omits the snapshot tag", async () => {
    const content = "line1\nline2\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}]\nSWAP 1.=1:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(/Missing hashline snapshot tag/)
  })

  test("rejects a tagged edit whose target file does not exist", async () => {
    const fs = new InMemoryFilesystem()
    const snapshots = new InMemorySnapshotStore()
    const fileHash = snapshots.record(PATH, "some\n")
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 1.=1:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(/File not found/)
  })

  test("applies a head/tail insert with a stale tag and warns instead of hard-failing", async () => {
    const content = "line1\nline2\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    // Record old content, then change file → stale tag
    const staleTag = snapshots.record(PATH, "different\n")
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${staleTag}]\nINS.HEAD:\n+new\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
    expect(result.sections[0].warnings).toContain(HEADTAIL_DRIFT_WARNING)
  })

  test("does not warn when a head/tail insert carries the live tag", async () => {
    const content = "line1\nline2\n"
    const fs = new InMemoryFilesystem([[PATH, content]])
    const snapshots = new InMemorySnapshotStore()
    const liveTag = computeFileHash(content)
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${liveTag}]\nINS.HEAD:\n+new\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].warnings).not.toContain(HEADTAIL_DRIFT_WARNING)
  })
})

// ============================================================================
// Patcher seen-line provenance
// ============================================================================
describe("Patcher seen-line provenance", () => {
  const CONTENT = "l1\nl2\nl3\nl4\nl5\n"

  test("rejects an edit anchored on a line the read never displayed", async () => {
    const fs = new InMemoryFilesystem([[PATH, CONTENT]])
    const snapshots = new InMemorySnapshotStore()
    // Record partial seen lines: only 1-2
    const fileHash = snapshots.record(PATH, CONTENT, [1, 2])
    const patcher = new Patcher({ fs, snapshots })

    // Edit anchors on line 4 — never seen
    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 4.=4:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(/never displayed/)
  })

  test("applies an edit anchored on a displayed line", async () => {
    const fs = new InMemoryFilesystem([[PATH, CONTENT]])
    const snapshots = new InMemorySnapshotStore()
    const fileHash = snapshots.record(PATH, CONTENT, [1, 2])
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 2.=2:\n+modified\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })

  test("widens coverage when more of the same content is re-read (read fusion)", async () => {
    const fs = new InMemoryFilesystem([[PATH, CONTENT]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, CONTENT, [1, 2])
    const fileHash = snapshots.record(PATH, CONTENT, [4, 5])
    const patcher = new Patcher({ fs, snapshots })

    // Edit anchors on line 4 — now seen due to fusion
    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 4.=4:\n+modified\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })

  test("skips the check when no seen lines were recorded (absent → allow)", async () => {
    const fs = new InMemoryFilesystem([[PATH, CONTENT]])
    const snapshots = new InMemorySnapshotStore()
    // Record without seenLines
    const fileHash = snapshots.record(PATH, CONTENT)
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 4.=4:\n+new\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })
})
