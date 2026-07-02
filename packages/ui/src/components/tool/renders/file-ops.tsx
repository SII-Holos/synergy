import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { useCodeComponent } from "../../../context/code"
import { BasicTool } from "../../basic-tool"
import {
  AnchoredParseCodeTool,
  AnchoredReviseTool,
  AnchoredSaveTool,
  AnchoredScanFilesTool,
  AnchoredViewTool,
} from "../../anchored-tool-card"
import { ToolRegistry, getDiagnostics, DiagnosticsDisplay } from "../../message-part"

ToolRegistry.register({ name: "view_file", render: AnchoredViewTool })
ToolRegistry.register({ name: "scan_files", render: AnchoredScanFilesTool })
ToolRegistry.register({ name: "parse_code", render: AnchoredParseCodeTool })
ToolRegistry.register({ name: "revise_file", render: AnchoredReviseTool })
ToolRegistry.register({ name: "save_file", render: AnchoredSaveTool })

ToolRegistry.register({
  name: "file_search",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "scan-document",
          title: "File Search",
          subtitle: props.input.query as string | undefined,
        }}
      />
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "pen-line",
          title: "Edit",
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
          changes: props.metadata.filediff as { additions: number; deletions: number } | undefined,
        }}
      >
        <Show when={props.status !== "generating" && (props.metadata.filediff || props.input.filePath)}>
          <ToolDiffPreview diff={props.metadata.filediff} />
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const codeComponent = useCodeComponent()
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "text-select",
          title: "Write",
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
        }}
      >
        <Show when={props.status !== "generating" && (props.input.content || props.input.filePath)}>
          <div data-component="write-content">
            <Dynamic
              component={codeComponent}
              file={{
                name: props.input.filePath ?? "file",
                contents: props.input.content,
                cacheKey: checksum(props.input.content),
              }}
              overflow="scroll"
            />
          </div>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "multiedit",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "pen-line",
          title: "Multi Edit",
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
        }}
      >
        <Show when={props.status !== "generating" && props.metadata.results}>
          {(results) => {
            const lastResult = () => {
              const r = results()
              if (!Array.isArray(r) || r.length === 0) return undefined
              return r[r.length - 1]
            }
            return <Show when={lastResult()?.filediff}>{(filediff) => <ToolDiffPreview diff={filediff()} />}</Show>
          }}
        </Show>
      </BasicTool>
    )
  },
})

function ToolDiffPreview(props: { diff: any }) {
  return (
    <div data-component="edit-content">
      <div class="text-12-regular text-text-weak">
        {props.diff?.beforeBytes ?? 0} bytes to {props.diff?.afterBytes ?? 0} bytes
        <Show when={props.diff?.truncated}> - preview truncated</Show>
      </div>
      <Show
        when={props.diff?.preview}
        fallback={<div class="text-12-regular text-text-weaker">No text preview available.</div>}
      >
        {(preview) => (
          <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-subtle p-3 text-12-regular text-text-base">
            {preview()}
          </pre>
        )}
      </Show>
    </div>
  )
}
