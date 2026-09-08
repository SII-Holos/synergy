import { Show, onCleanup } from "solid-js"
import type { PluginComponentProps, PluginInputService } from "@ericsanchezok/synergy-plugin"

export function DefaultComposerEditor(
  props: PluginComponentProps<{ input: PluginInputService }> & { onError(error: unknown): void },
) {
  const input = props.context.input
  let scroller!: HTMLDivElement
  return (
    <div class="relative max-h-[240px] overflow-y-auto" ref={scroller}>
      <div
        data-component="prompt-input"
        role="textbox"
        aria-multiline="true"
        aria-label={input.editor.label()}
        ref={(element) => onCleanup(input.editor.mount(element, scroller))}
        contenteditable={!input.readOnly()}
        onBeforeInput={input.editor.beforeInput}
        onInput={input.editor.input}
        onPaste={(event) => {
          void input.editor.paste(event).catch(props.onError)
        }}
        onCompositionStart={() => input.setComposing(true)}
        onCompositionEnd={() => input.setComposing(false)}
        onKeyDown={input.editor.keyDown}
        class="select-text w-full px-4 py-3 pr-12 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap [&_[data-type=file]]:text-syntax-property"
        classList={{ "font-mono!": input.current().mode === "shell" }}
      />
      <Show when={input.editor.completion()}>
        {(completion) => (
          <div class="absolute top-0 inset-x-0 px-4 py-3 pr-12 text-14-regular pointer-events-none whitespace-pre-wrap text-text-subtle">
            <span class="invisible">{completion().prefix}</span>
            <span>{completion().text}</span>
          </div>
        )}
      </Show>
      <Show when={input.editor.placeholder()}>
        {(placeholder) => (
          <div class="absolute top-0 inset-x-0 px-4 py-3 pr-12 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate">
            {placeholder()}
          </div>
        )}
      </Show>
    </div>
  )
}
