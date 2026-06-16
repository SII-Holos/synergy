import { For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import type { RawValidationState } from "../types"

export function RawEditorPanel(props: {
  rawPath: string | undefined
  rawText: () => string
  rawValidation: RawValidationState
  validatingRaw: () => boolean
  hasRawChanges: () => boolean
  onValidate: () => void
  onTextChange: (value: string) => void
}) {
  return (
    <div class="ds-content-inner ds-raw-editor-container">
      <Show when={props.rawPath}>
        <p class="ds-section-hint mb-2 truncate max-w-full">{props.rawPath}</p>
      </Show>
      <div class="flex items-center gap-2 mb-3">
        <Button
          type="button"
          variant="ghost"
          size="small"
          disabled={props.validatingRaw() || !props.hasRawChanges()}
          onClick={() => void props.onValidate()}
        >
          {props.validatingRaw() ? "Validating..." : "Validate"}
        </Button>
      </div>
      <Show when={props.rawValidation.errors.length > 0}>
        <div class="ds-raw-validation ds-raw-validation-error">
          <For each={props.rawValidation.errors}>{(err) => <div class="ds-raw-validation-item">{err}</div>}</For>
        </div>
      </Show>
      <Show when={props.rawValidation.warnings.length > 0}>
        <div class="ds-raw-validation ds-raw-validation-warning">
          <For each={props.rawValidation.warnings}>{(warn) => <div class="ds-raw-validation-item">{warn}</div>}</For>
        </div>
      </Show>
      <textarea
        class="ds-raw-textarea"
        value={props.rawText()}
        onInput={(e) => {
          props.onTextChange(e.currentTarget.value)
        }}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        wrap="off"
      />
    </div>
  )
}
