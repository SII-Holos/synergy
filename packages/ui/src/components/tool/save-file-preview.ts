import type { ToolProps } from "../tool-registry-lazy"
import type { ToolDiffPreviewFileDiff } from "./diff-preview"

export function saveFilePreviewDiff(props: Pick<ToolProps, "metadata">): ToolDiffPreviewFileDiff | undefined {
  return props.metadata?.filediff as ToolDiffPreviewFileDiff | undefined
}

export function hasSaveFileContentInput(props: Pick<ToolProps, "input">): boolean {
  return typeof props.input.content === "string"
}
