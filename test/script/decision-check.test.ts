import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkRecord } from "../../script/decision-check"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-decision-check-"))
  roots.push(root)
  return root
}

function recordPath(root: string, lifecycle: string, cls: string, name = "2026-08-14-topic-title") {
  return path.join(root, "docs", "decisions", lifecycle, cls, `${name}.md`)
}

const implementedBody = `# Decision Record: Example topic

Status: implemented

## Problem

The thing was wrong.

## Decision

Shipped the fix.

## Alternatives considered

- **Other fix** — rejected because it was worse.

## Consequences

Now it works.
`

describe("decision record format gate", () => {
  test("accepts a complete implemented record", async () => {
    const root = await fixture()
    const file = recordPath(root, "implemented", "process")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, implementedBody)
    expect(checkRecord(file, path.join(root, "docs", "decisions"), root)).toEqual([])
  })

  test("rejects wrong path shape", async () => {
    const root = await fixture()
    const file = path.join(root, "docs", "decisions", "implemented", "process", "nested", "2026-08-14-x.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, implementedBody)
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("must live at"))).toBe(true)
  })

  test("rejects unknown lifecycle and class folders", async () => {
    const root = await fixture()
    const file = recordPath(root, "draft", "misc")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, implementedBody)
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("unknown lifecycle folder 'draft'"))).toBe(true)
    expect(errors.some((error) => error.includes("unknown class folder 'misc'"))).toBe(true)
  })

  test("rejects bad filename", async () => {
    const root = await fixture()
    const file = recordPath(root, "implemented", "process", "not-a-date-title")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, implementedBody)
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("filename must be"))).toBe(true)
  })

  test("rejects mismatched Status line", async () => {
    const root = await fixture()
    const file = recordPath(root, "implemented", "process")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, implementedBody.replace("Status: implemented", "Status: proposed"))
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("must equal lifecycle folder"))).toBe(true)
  })

  test("rejects missing Alternatives considered in implemented records", async () => {
    const root = await fixture()
    const file = recordPath(root, "implemented", "process")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      implementedBody.replace("## Alternatives considered\n\n- **Other fix** — rejected because it was worse.\n", ""),
    )
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("Alternatives considered' is mandatory"))).toBe(true)
  })

  test("rejects spec-speak headings in implemented records", async () => {
    const root = await fixture()
    const file = recordPath(root, "implemented", "process")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${implementedBody}\n## Proposal\n\nSpec speak.\n`)
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("'## Proposal' is not allowed"))).toBe(true)
  })

  test("accepts a rejected record with reason", async () => {
    const root = await fixture()
    const file = recordPath(root, "rejected", "feature")
    await mkdir(path.dirname(file), { recursive: true })
    const body = `# Decision Record: Declined feature

Status: rejected — too expensive

## Problem

Someone wanted it.

## Proposal

Build it.

## Alternatives considered

- **Do nothing** — rejected: the record itself documents why.

## Acceptance criteria

None.

## Risks

None.
`
    await writeFile(file, body)
    expect(checkRecord(file, path.join(root, "docs", "decisions"), root)).toEqual([])
  })

  test("rejects a rejected record without a reason", async () => {
    const root = await fixture()
    const file = recordPath(root, "rejected", "feature")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `# Decision Record: Declined\n\nStatus: rejected\n\n## Problem\n\nx\n\n## Proposal\n\ny\n\n## Alternatives considered\n\n- **z** — nope\n\n## Acceptance criteria\n\nnone\n\n## Risks\n\nnone\n`,
    )
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors.some((error) => error.includes("rejected —"))).toBe(true)
  })

  test("accepts archived records with implemented status", async () => {
    const root = await fixture()
    const file = recordPath(root, "archived", "architecture")
    await mkdir(path.dirname(file), { recursive: true })
    const body = implementedBody.replace("Status: implemented", "Status: implemented\nArchived: 2026-08-14")
    await writeFile(file, body)
    const errors = checkRecord(file, path.join(root, "docs", "decisions"), root)
    expect(errors).toEqual([])
  })
})
