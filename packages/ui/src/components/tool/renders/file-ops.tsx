import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { useDiffComponent } from "../../../context/diff"
import { useCodeComponent } from "../../../context/code"
import { BasicTool } from "../../basic-tool"
import { DiffChanges } from "../../diff-changes"
import {
  AnchoredParseCodeTool,
  AnchoredReviseTool,
  AnchoredSaveTool,
  AnchoredScanFilesTool,
  AnchoredViewTool,
} from "../../anchored-tool-card"
import { ToolRegistry, getDirectory, getDiagnostics, DiagnosticsDisplay } from "../../message-part"
import { getFilename } from "@ericsanchezok/synergy-util/path"

ToolRegistry.register({ name: "view_file", render: AnchoredViewTool })
ToolRegistry.register({ name: "scan_files", render: AnchoredScanFilesTool })
ToolRegistry.register({ name: "parse_code", render: AnchoredParseCodeTool })
ToolRegistry.register({ name: "revise_file", render: AnchoredReviseTool })
ToolRegistry.register({ name: "save_file", render: AnchoredSaveTool })

ToolRegistry.register({
  name: "edit",
  render(props) {
    const diffComponent = useDiffComponent()
    const diagnostics = createMemo(() =>
      props.status === "completed" ? getDiagnostics(props.metadata.diagnostics, props.input.filePath) : [],
    )
    return (
      <BasicTool
        {...props}
        icon="pen-line"
        trigger={
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Edit</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
            <div data-slot="message-part-actions">
              <Show when={props.metadata.filediff}>
                <DiffChanges changes={props.metadata.filediff} />
              </Show>
            </div>
          </div>
        }
      >
        <Show when={props.status !== "generating" && (props.metadata.filediff?.path || props.input.filePath)}>
          <div data-component="edit-content">
            <Dynamic
              component={diffComponent}
              before={{
                name: props.metadata?.filediff?.file || props.input.filePath || "file",
                contents: props.metadata?.filediff?.before || props.input.oldString,
              }}
              after={{
                name: props.metadata?.filediff?.file || props.input.filePath || "file",
                contents: props.metadata?.filediff?.after || props.input.newString,
              }}
            />
          </div>
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
        icon="text-select"
        trigger={
          <div data-component="write-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Write</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
            <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
          </div>
        }
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
    const diffComponent = useDiffComponent()
    return (
      <BasicTool
        {...props}
        icon="pen-line"
        trigger={
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">Multi Edit</div>
              <div data-slot="message-part-path">
                <Show when={props.input.filePath?.includes("/")}>
                  <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                </Show>
                <span data-slot="message-part-filename">{getFilename(props.input.filePath ?? "")}</span>
              </div>
            </div>
          </div>
        }
      >
        <Show when={props.status !== "generating" && props.metadata.results}>
          {(results) => {
            const lastResult = () => {
              const r = results()
              if (!Array.isArray(r) || r.length === 0) return undefined
              return r[r.length - 1]
            }
            return (
              <Show when={lastResult()?.filediff}>
                {(filediff) => (
                  <div data-component="edit-content">
                    <Dynamic
                      component={diffComponent}
                      before={{
                        name: filediff().file || props.input.filePath || "file",
                        contents: filediff().before,
                      }}
                      after={{
                        name: filediff().file || props.input.filePath || "file",
                        contents: filediff().after,
                      }}
                    />
                  </div>
                )}
              </Show>
            )
          }}
        </Show>
      </BasicTool>
    )
  },
})
