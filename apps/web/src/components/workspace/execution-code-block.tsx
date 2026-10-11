import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"

export function ExecutionCodeBlock(props: {
  identity: string
  slot: string
  label: string
  copyLabel: string
  text: string
  language?: "json"
  incomplete?: boolean
}) {
  const { _ } = useLingui()
  const [expanded, setExpanded] = createSignal(false)
  const identity = createMemo(() => props.identity)
  const copyLabel = () =>
    props.incomplete ? _({ id: "session.execution.copyLoaded", message: "Copy loaded output" }) : props.copyLabel
  const copy = createCopyController({
    text: () => props.text,
    get copyLabel() {
      return copyLabel()
    },
    get copiedLabel() {
      return _({ id: "session.execution.copied", message: "Copied" })
    },
    get failedLabel() {
      return _({ id: "session.execution.copyFailed", message: "Copy failed" })
    },
  })
  createEffect(
    on(identity, () => {
      setExpanded(false)
      copy.reset()
    }),
  )
  return (
    <section data-component="execution-code-block" data-slot={props.slot} aria-label={props.label}>
      <header>
        <h3>{props.label}</h3>
        <span data-slot="execution-code-language">{props.language === "json" ? "JSON" : "text"}</span>
        <Button
          variant="ghost"
          size="small"
          icon={copy.icon()}
          aria-label={copyLabel()}
          title={copy.tooltip()}
          disabled={copy.disabled()}
          onClick={() => void copy.copy()}
        />
        <span data-slot="execution-copy-feedback" role="status">
          {copy.state() === "idle" ? "" : copy.tooltip()}
        </span>
      </header>
      <Show when={props.incomplete}>
        <p data-slot="execution-partial-notice" role="status">
          {_({
            id: "session.execution.loadedPortion",
            message: "Only part of this output was loaded. Copy and expand apply to the loaded portion.",
          })}
        </p>
      </Show>
      <div data-slot="execution-code-content">
        <Show
          when={props.text.length > 0}
          fallback={<p>{_({ id: "session.execution.noOutput", message: "No output captured." })}</p>}
        >
          <pre>
            <code>{expanded() ? props.text : props.text.slice(0, 16000)}</code>
          </pre>
        </Show>
      </div>
      <Show when={props.text.length > 16000 && !expanded()}>
        <button type="button" data-slot="execution-code-expand" onClick={() => setExpanded(true)}>
          {props.incomplete
            ? _({ id: "session.execution.expandLoaded", message: "Expand loaded portion" })
            : _({ id: "session.execution.fullContent", message: "Show full content" })}
        </button>
      </Show>
    </section>
  )
}
