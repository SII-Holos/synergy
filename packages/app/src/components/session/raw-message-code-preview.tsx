import { useCodeComponent } from "@ericsanchezok/synergy-ui/context/code"
import { Dynamic } from "solid-js/web"

export interface RawMessageCodePreviewFile {
  name: string
  contents: string
  cacheKey?: string
}

export function rawMessageCodeOverflow(wrap: boolean): "scroll" | "wrap" {
  return wrap ? "wrap" : "scroll"
}

export function rawMessageCodeColumns(contents: string): number {
  const longestLine = contents.split("\n").reduce((longest, line) => Math.max(longest, line.length), 0)
  return Math.min(1000, Math.max(40, longestLine + 6))
}

export function RawMessageCodePreview(props: { file: RawMessageCodePreviewFile; wrap: boolean }) {
  const codeComponent = useCodeComponent()
  return (
    <div
      class="raw-message-code-content"
      classList={{ "is-wrapped": props.wrap }}
      style={`--raw-message-code-width: ${rawMessageCodeColumns(props.file.contents)}ch`}
    >
      <Dynamic
        component={codeComponent}
        file={props.file}
        overflow={rawMessageCodeOverflow(props.wrap)}
        class="raw-messages-code select-text"
      />
    </div>
  )
}
