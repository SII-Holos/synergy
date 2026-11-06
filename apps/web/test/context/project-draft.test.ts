import { expect, test } from "bun:test"
import { mergeProjectDrafts, qualifyProjectDraft } from "../../src/context/prompt/project-draft"
import type { Prompt } from "../../src/context/prompt"

const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]

test("merging keeps destination text first and deduplicates uploaded assets", () => {
  const attachment = {
    type: "attachment" as const,
    id: "one",
    filename: "note.txt",
    mime: "text/plain",
    url: "asset://one",
  }
  const result = mergeProjectDrafts(
    { prompt: [...text("target"), attachment], context: { items: [] } },
    { prompt: [...text("source"), { ...attachment, id: "two" }], context: { items: [] } },
  )
  expect(
    result.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(""),
  ).toBe("target\n\nsource")
  expect(result.prompt.filter((part) => part.type === "attachment")).toHaveLength(1)
  expect(result.prompt.find((part) => part.type === "text" && part.content === "source")).toMatchObject({ start: 8 })
})

test("project-relative file references retain their original directory", () => {
  const result = qualifyProjectDraft(
    {
      prompt: [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }],
      context: { items: [{ type: "file", path: "src/b.ts" }] },
    },
    "source",
    "/projects/source",
  )
  expect(result.prompt[0]).toMatchObject({ path: "/projects/source/src/a.ts" })
  expect(result.context.items[0].path).toBe("/projects/source/src/b.ts")
})

test("file references without a native directory retain an unavailable source marker", () => {
  const result = qualifyProjectDraft(
    { prompt: [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }], context: { items: [] } },
    "source",
  )
  expect(result.prompt[0]).toMatchObject({ path: "src/a.ts", originScopeID: "source" })
})
