import { Show } from "solid-js"
import type { PluginComponentProps, PluginShellContext } from "@ericsanchezok/synergy-plugin"
import { Button, HostView } from "@ericsanchezok/synergy-plugin/components"

export default function Session({ context }: PluginComponentProps<PluginShellContext>) {
  const input = () => context.input
  const report = (error: unknown) => {
    if (context.lifetime.signal.aborted) return
    context.overlays.notify(error instanceof Error ? error.message : String(error), { kind: "error" })
  }
  const edit = (element: HTMLTextAreaElement) => {
    const composer = input()
    if (!composer || composer.composing()) return
    const snapshot = composer.current()
    const selection = { start: element.selectionStart, end: element.selectionEnd }
    void composer
      .applyEdits({
        revision: snapshot.revision,
        edits: [{ range: { start: 0, end: snapshot.text.length }, text: element.value }],
      })
      .then((result) => {
        if (element.isConnected && composer.current().revision === result.revision) composer.select(selection)
      })
      .catch(report)
  }
  return (
    <div class="studio-session" data-ui-part="session">
      <div class="studio-workarea">
        <div class="studio-session-main">
          <section class="studio-conversation" data-ui-part="conversation">
            <HostView shell={context.shell} view="conversation" />
          </section>
          <Show when={input()}>
            {(composer) => (
              <form
                class="studio-composer"
                data-ui-part="composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  void composer().submit().catch(report)
                }}
              >
                {context.extensions.render({ slot: "composer.above" })}
                <textarea
                  aria-label="Message"
                  value={composer().current().text}
                  disabled={composer().readOnly() || !composer().ready() || composer().submitting()}
                  onCompositionStart={() => composer().setComposing(true)}
                  onCompositionEnd={(event) => {
                    composer().setComposing(false)
                    edit(event.currentTarget)
                  }}
                  onInput={(event) => edit(event.currentTarget)}
                />
                <div class="studio-toolbar">
                  {context.extensions.render({ slot: "composer.toolbar.left" })}
                  <Button type="submit" disabled={!composer().canSubmit() || composer().submitting()}>
                    Send
                  </Button>
                  <Show when={context.session?.status().type === "busy"}>
                    <Button
                      onClick={() => {
                        void composer().stop().catch(report)
                      }}
                    >
                      Stop
                    </Button>
                  </Show>
                  {context.extensions.render({ slot: "composer.toolbar.right" })}
                </div>
                {context.extensions.render({ slot: "composer.below" })}
              </form>
            )}
          </Show>
        </div>
        <HostView shell={context.shell} view="workbench.side" />
      </div>
      <HostView shell={context.shell} view="workbench.bottom" />
    </div>
  )
}
