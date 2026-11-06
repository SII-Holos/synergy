import { createEffect, createSignal, on, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { ExecutionCodeBlock } from "./execution-code-block"
import type { ProcessTaskOutput } from "./process-task-output"

export function ExecutionReport(props: { identity: string; report: ProcessTaskOutput }) {
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(false)
  const copy = createCopyController({
    text: () => props.report.text,
    get copyLabel() {
      return _({ id: "session.process.copyResult", message: "Copy result" })
    },
    get copiedLabel() {
      return _({ id: "session.execution.copied", message: "Copied" })
    },
    get failedLabel() {
      return _({ id: "session.execution.copyFailed", message: "Copy failed" })
    },
  })
  createEffect(
    on(
      () => props.identity,
      () => {
        setExpanded(false)
        copy.reset()
      },
    ),
  )
  return (
    <Show
      when={props.report.language !== "json"}
      fallback={
        <ExecutionCodeBlock
          identity={props.identity}
          slot="execution-output"
          language="json"
          label={_({ id: "session.execution.result", message: "Result" })}
          copyLabel={_({ id: "session.process.copyResult", message: "Copy result" })}
          text={props.report.text}
        />
      }
    >
      <section data-component="execution-report">
        <header>
          <h3>{_({ id: "session.execution.result", message: "Result" })}</h3>
          <Button
            variant="ghost"
            size="small"
            icon={copy.icon()}
            aria-label={_({ id: "session.process.copyResult", message: "Copy result" })}
            title={copy.tooltip()}
            disabled={!props.report.text || copy.disabled()}
            onClick={() => void copy.copy()}
          />
          <span data-slot="execution-copy-feedback" role="status">
            {copy.state() === "idle" ? "" : copy.tooltip()}
          </span>
        </header>
        <Show
          when={props.report.text}
          fallback={
            <p data-slot="execution-evidence-gap">
              {_({ id: "session.process.noReport", message: "No final report was captured." })}
            </p>
          }
        >
          <Markdown text={expanded() ? props.report.text : props.report.text.slice(0, 16000)} />
        </Show>
        <Show when={props.report.text.length > 16000 && !expanded()}>
          <Button variant="ghost" onClick={() => setExpanded(true)}>
            {_({ id: "session.execution.fullContent", message: "Show full content" })}
          </Button>
        </Show>
      </section>
    </Show>
  )
}

export function ExecutionTrajectory(props: { identity: string; report: ProcessTaskOutput }) {
  const { _ } = useLingui()
  return (
    <>
      <p data-slot="execution-file-context">
        {_({
          id: "session.process.statistics",
          message: "{steps} steps · {calls} tool calls",
          values: { steps: props.report.steps, calls: props.report.toolCalls },
        })}
      </p>
      <ExecutionCodeBlock
        identity={props.identity}
        slot="execution-trajectory"
        label={_({ id: "session.process.execution", message: "Execution process" })}
        copyLabel={_({ id: "session.process.copyExecution", message: "Copy execution process" })}
        text={props.report.trajectory ?? ""}
      />
    </>
  )
}

export function ExecutionOriginal(props: {
  identity: string
  text: string
  copyLabel?: string
  incomplete?: boolean
  language?: "json"
}) {
  const { _ } = useLingui()
  return (
    <details data-slot="execution-raw-output">
      <summary>{_({ id: "session.process.rawOutput", message: "Original output" })}</summary>
      <ExecutionCodeBlock
        identity={props.identity}
        slot="execution-original"
        label={_({ id: "session.process.rawOutput", message: "Original output" })}
        copyLabel={props.copyLabel ?? _({ id: "session.process.copyOriginal", message: "Copy original output" })}
        text={props.text}
        language={props.language}
        incomplete={props.incomplete}
      />
    </details>
  )
}
