import { TOOL_TITLE_DESC, TOOL_LABEL_DESC } from "../../tool-title-descriptors"
import { useLingui } from "@lingui/solid"
import { createMemo, For, Show } from "solid-js"
import { BasicTool, useToolResultPresentation } from "../../basic-tool"
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
import { ToolFilePreview, ToolPatchPreview } from "../content-preview"
import { PATCH_OUTCOMES, patchOutcome, patchSections } from "../patch-result"

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const { _ } = useLingui()
    const resultOnly = useToolResultPresentation()
    const sections = createMemo(() => patchSections(props.metadata?.sections))
    const outcome = () => patchOutcome(props.metadata?.outcome)
    const error = () => (typeof props.metadata?.error === "string" ? props.metadata.error : undefined)
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "diff",
          title: TOOL_TITLE_DESC["apply_patch"],
          tags: outcome()
            ? [
                {
                  label: _(PATCH_OUTCOMES[outcome()!]),
                  tone: outcome() === "applied" ? "success" : outcome() === "no-change" ? "default" : "warning",
                },
              ]
            : undefined,
        }}
      >
        <Show
          when={outcome()}
          fallback={
            <Show when={props.output}>
              <div data-component="tool-output" data-scrollable>
                <ToolTextOutput text={props.output!} />
              </div>
            </Show>
          }
        >
          <Show
            when={
              error() && (!resultOnly || !sections().length) && !sections().some((section) => section.error === error())
            }
          >
            <p class="break-words text-sm">{error()}</p>
          </Show>
          <div class="flex flex-col gap-4" data-component="patch-result">
            <For each={sections().filter((section) => section.diff && section.observedPath)}>
              {(section) => (
                <div class="flex flex-col gap-2" data-component="patch-section" data-state={section.state}>
                  <Show when={!resultOnly && section.error}>
                    <p class="break-words text-sm">{section.error}</p>
                  </Show>
                  <Show when={section.diff && section.observedPath}>
                    <ToolPatchPreview tool={props} path={section.observedPath!} patch={section.diff} />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

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
    const resultOnly = useToolResultPresentation()
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
            return <ToolPatchPreview tool={props} path={props.input.filePath} patch={patch()} />
          }}
        </Show>
        <Show when={!resultOnly}>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </Show>
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
                  return <ToolPatchPreview tool={props} path={props.input.filePath} patch={patch()} />
                }}
              </Show>
            )
          }}
        </Show>
      </BasicTool>
    )
  },
})
