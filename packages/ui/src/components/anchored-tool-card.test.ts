import { describe, expect, test } from "bun:test"
import { hasSaveFileContentInput, saveFilePreviewDiff } from "./tool/save-file-preview"
import type { ToolProps } from "./tool-registry-lazy"

function toolProps(input: Partial<ToolProps>): ToolProps {
  return {
    input: {},
    metadata: {},
    tool: "save_file",
    ...input,
  }
}

describe("save file preview", () => {
  test("uses filediff metadata for create-file previews", () => {
    const filediff = {
      file: ".commitmsg-n02.txt",
      additions: 5,
      deletions: 0,
      preview: "@@ -0,0 +1,5 @@\n+docs: add N02 frame research problem design",
    }

    expect(
      saveFilePreviewDiff(
        toolProps({
          input: {
            filePath: ".commitmsg-n02.txt",
            content: "docs: add N02 frame research problem design",
          },
          metadata: {
            exists: false,
            filediff,
          },
        }),
      ),
    ).toBe(filediff)
  })

  test("only falls back to content preview when content input is present", () => {
    expect(hasSaveFileContentInput(toolProps({ input: { filePath: "empty.txt", content: "" } }))).toBe(true)
    expect(hasSaveFileContentInput(toolProps({ input: { filePath: "missing-content.txt" } }))).toBe(false)
  })
})
