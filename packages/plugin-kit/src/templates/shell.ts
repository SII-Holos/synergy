export function shellDefinition(id: string) {
  return `import { capability, definePlugin, shell } from "@ericsanchezok/synergy-plugin"

const access = ["ui.shell", "ui.hostActions", "session.read", "session.submit", "session.control", "composer.read", "composer.write"]
export default definePlugin({
  id: ${JSON.stringify(id)}, version: "0.1.0", description: "A custom Synergy workbench",
  capabilities: access.map((id) => capability(id)),
  contributions: [shell({
    id: "main", label: "Studio", requires: access,
    component: { source: "./src/ui.tsx" },
    pages: { session: { source: "./src/session.tsx" } },
  })],
})
`
}
export const shellSource = `import type { PluginComponentProps, PluginShellContext } from "@ericsanchezok/synergy-plugin"
import { Button, HostView } from "@ericsanchezok/synergy-plugin/components"
import "./shell.css"

export default function Studio({ context }: PluginComponentProps<PluginShellContext>) {
  return <div class="studio" data-ui-part="workbench">
    <header class="studio-toolbar" data-ui-part="toolbar">
      <strong>Studio</strong>
      <Button onClick={() => context.navigation.open({ page: "session" })}>New session</Button>
      <Button onClick={() => context.navigation.open({ page: "plugins" })}>Plugins</Button>
    </header>
    <main class="studio-main" data-ui-part="content"><HostView shell={context.shell} view="route" /></main>
    <footer class="studio-footer">{context.extensions.render({ slot: "app.footer" })}</footer>
  </div>
}
`
export const shellSessionSource = `import { Show } from "solid-js"
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
    void composer.applyEdits({ revision: snapshot.revision, edits: [{ range: { start: 0, end: snapshot.text.length }, text: element.value }] })
      .then(result => { if (element.isConnected && composer.current().revision === result.revision) composer.select(selection) }).catch(report)
  }
  return <div class="studio-session" data-ui-part="session">
    <div class="studio-workarea">
      <div class="studio-session-main">
        <section class="studio-conversation" data-ui-part="conversation"><HostView shell={context.shell} view="conversation" /></section>
        <Show when={input()}>{(composer) => <form class="studio-composer" data-ui-part="composer" onSubmit={(event) => {
          event.preventDefault()
          void composer().submit().catch(report)
        }}>
          {context.extensions.render({ slot: "composer.above" })}
          <textarea aria-label="Message" value={composer().current().text} disabled={composer().readOnly() || !composer().ready() || composer().submitting()}
            onCompositionStart={() => composer().setComposing(true)}
            onCompositionEnd={(event) => { composer().setComposing(false); edit(event.currentTarget) }}
            onInput={(event) => edit(event.currentTarget)} />
          <div class="studio-toolbar">
            {context.extensions.render({ slot: "composer.toolbar.left" })}
            <Button type="submit" disabled={!composer().canSubmit() || composer().submitting()}>Send</Button>
            <Show when={context.session?.status().type === "busy"}><Button onClick={() => { void composer().stop().catch(report) }}>Stop</Button></Show>
            {context.extensions.render({ slot: "composer.toolbar.right" })}
          </div>
          {context.extensions.render({ slot: "composer.below" })}
        </form>}</Show>
      </div>
      <HostView shell={context.shell} view="workbench.side" />
    </div>
    <HostView shell={context.shell} view="workbench.bottom" />
  </div>
}
`
export const shellCSS = `.studio { display:flex; flex-direction:column; height:100%; min-height:0; width:100%; }
.studio-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px; }
.studio-main, .studio-session { display:flex; flex:1; flex-direction:column; min-height:0; min-width:0; }
.studio-workarea { display:flex; flex:1; min-height:0; min-width:0; }
.studio-session-main { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
.studio-main { position:relative; overflow:hidden; }
.studio-conversation { position:relative; overflow:hidden; display:flex; flex:1; min-height:0; }
.studio-composer { display:flex; flex-direction:column; gap:8px; padding:16px; }
.studio-composer textarea { min-height:100px; resize:vertical; border:1px solid var(--border-base); border-radius:8px; padding:12px; color:var(--text-base); background:var(--surface-base); font:inherit; }
.studio-footer { display:flex; flex-wrap:wrap; gap:8px; }
`
