import { TOOL_TITLE_DESC, TOOL_LABEL_DESC } from "../../tool-title-descriptors"
import { useLingui } from "@lingui/solid"
import { createMemo, Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import {
  AnchoredParseCodeTool,
  AnchoredResolveConflictsTool,
  AnchoredReviseTool,
  AnchoredSaveTool,
  AnchoredScanFilesTool,
  AnchoredViewTool,
} from "../../anchored-tool-card"
import { ToolRegistry, getDiagnostics, DiagnosticsDisplay } from "../../message-part"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolDiffPreview } from "../diff-preview"
import { ToolFilePreview, ToolPatchPreview } from "../content-preview"

ToolRegistry.register({ name: "view_file", render: AnchoredViewTool })
ToolRegistry.register({ name: "scan_files", render: AnchoredScanFilesTool })
ToolRegistry.register({ name: "parse_code", render: AnchoredParseCodeTool })
ToolRegistry.register({ name: "revise_file", render: AnchoredReviseTool })
ToolRegistry.register({ name: "resolve_conflicts", render: AnchoredResolveConflictsTool })
ToolRegistry.register({ name: "save_file", render: AnchoredSaveTool })

ToolRegistry.register({
  name: "file_search",
  render(props) {
    const { _ } = useLingui()
    const count = () => props.metadata?.count as number | undefined
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "scan-document",
          title: TOOL_TITLE_DESC["file_search"],
          subtitle: props.input.query as string | undefined,
          tags:
            count() != null ? [{ label: _({ ...TOOL_LABEL_DESC.results, values: { count: count()! } }) }] : undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
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
          title: TOOL_TITLE_DESC["edit"],
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
          changes: props.metadata.filediff as { additions: number; deletions: number } | undefined,
        }}
      >
        <Show when={props.status !== "generating" && props.metadata.filediff}>
          {(filediff) => {
            const patch = () =>
              (props.metadata.diff as string | undefined) ?? (filediff().preview as string | undefined)
            return (
              <ToolPatchPreview
                tool={props}
                path={props.input.filePath}
                patch={patch()}
                fallback={<ToolDiffPreview diff={filediff()} />}
              />
            )
          }}
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "text-select",
          title: TOOL_TITLE_DESC["write"],
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
        }}
      >
        <Show when={props.status !== "generating" && (props.input.content || props.input.filePath)}>
          <div data-component="write-content">
            <ToolFilePreview path={props.input.filePath} content={props.input.content ?? ""} />
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
          title: TOOL_TITLE_DESC["multiedit"],
          subtitlePath: (props.input.filePath as string | undefined) ?? undefined,
        }}
      >
        <Show keyed when={props.status !== "generating" ? props.metadata.results : undefined}>
          {(results) => {
            if (!Array.isArray(results) || results.length === 0) return null
            const lastResult = results[results.length - 1]
            return (
              <Show keyed when={lastResult?.filediff}>
                {(filediff) => {
                  const patch = () =>
                    (lastResult?.diff as string | undefined) ?? (filediff.preview as string | undefined)
                  return (
                    <ToolPatchPreview
                      tool={props}
                      path={props.input.filePath}
                      patch={patch()}
                      fallback={<ToolDiffPreview diff={filediff} />}
                    />
                  )
                }}
              </Show>
            )
          }}
        </Show>
      </BasicTool>
    )
  },
})
