import type { PluginComposerLayoutService, PluginSessionLayoutService } from "@ericsanchezok/synergy-plugin"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { Show, createSignal, onCleanup } from "solid-js"
import { ComposerPresentation, bindComposerPresentation } from "@/components/prompt-input/composer-presentation"
import { ConversationPresentation } from "@/components/session/conversation-presentation"
import { createPromptDockHeight } from "@/components/session/prompt-dock-height"
import { PromptDock } from "@/components/session/prompt-dock"
import { SessionEmptyView } from "@/components/session/session-new-view"
import { WelcomeHeading, WelcomeStage } from "@/components/session/welcome/stage"
import type { WelcomeMemory, WelcomeSceneDefinition } from "@/components/session/welcome/types"
import { DefaultSession } from "@/plugin/default-session"
import { HostView } from "@/plugin/host-view"
import { createComposerFixtureInput } from "./composer-input"
import "@/components/top-bar/session-top-bar.css"

export function WelcomeLayout(props: { definition: WelcomeSceneDefinition; memory: WelcomeMemory; blocked: boolean }) {
  const query = new URLSearchParams(location.search)
  const state = new ComposerPresentation()
  const [text, setText] = createSignal(query.has("draft") ? Array(24).fill("Restored draft line").join("\n") : "")
  const [revision, setRevision] = createSignal(0)
  const [attached, setAttached] = createSignal(query.has("attachments"))
  const [pending, setPending] = createSignal(false)
  const [extension, setExtension] = createSignal(false)
  const [games, setGames] = createSignal(true)
  const [welcome, setWelcome] = createSignal(true)
  const [promptHeight, setPromptHeight] = createSignal(0)
  const dock = createPromptDockHeight(setPromptHeight)
  let editor: HTMLDivElement | undefined
  const input = createComposerFixtureInput({
    editor: {
      label: () => "Message",
      mount(element) {
        editor = element
        element.innerText = text()
        return () => {
          editor = undefined
        }
      },
      beforeInput() {},
      input() {
        setText(editor?.innerText ?? "")
        setRevision((value) => value + 1)
      },
      async paste() {},
      keyDown(event) {
        if (event.key === "Escape") state.collapse()
      },
      completion: () => undefined,
      placeholder: () => (text() ? undefined : "Describe a task"),
    },
    current: () => ({ revision: revision(), text: text(), selection: { start: 0, end: 0 }, mode: "normal" }),
    render(part) {
      if (part === "leading") return <div style="height:44px;flex:none;padding:10px 16px">Fixture project</div>
      if (part === "context")
        return (
          <Show when={attached()}>
            <div role="group" aria-label="Attachments" style="height:88px;padding:8px 16px">
              <div style="height:72px;width:96px;background:var(--surface-inset-base)">image.png</div>
            </div>
          </Show>
        )
      if (part === "toolbar")
        return (
          <div style="height:48px;display:flex;justify-content:flex-end;align-items:center;padding-inline:16px">
            <button type="submit">Send</button>
          </div>
        )
    },
  })
  onCleanup(
    bindComposerPresentation(input, {
      state,
      hasAttachments: attached,
      preview: () => ({ text: text(), references: [] }),
    }),
  )
  const composerLayout: PluginComposerLayoutService = {
    input: () => input,
    mount: dock.mount,
    ready: () => true,
    isNewSession: welcome,
    readOnly: () => false,
    isGlobal: () => true,
    pendingText: () => "",
    scopeName: () => "Fixture project",
    branch: () => undefined,
    lastModified: () => null,
    links: () => [],
    render: () => undefined,
  }
  const layout: PluginSessionLayoutService = {
    minimumWidth: () => undefined,
    promptHeight,
    render(part) {
      if (part === "conversation")
        return (
          <HostView
            render={() => (
              <ConversationPresentation owner={["fixture", "home", "new"]} ready>
                <div data-session-top-bar class="stb-root" />
                <div class="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                  <Show when={welcome()} fallback={<div data-fixture-transcript>Conversation</div>}>
                    <SessionEmptyView
                      interactive
                      greeting={
                        <Show
                          when={games()}
                          fallback={
                            <div class="session-greeting">
                              <WelcomeHeading />
                            </div>
                          }
                        >
                          <WelcomeStage
                            definition={props.definition}
                            memory={props.memory}
                            seed={8}
                            blocked={props.blocked}
                          />
                        </Show>
                      }
                    >
                      <Show when={extension()}>
                        <div style="height:160px;display:flex;align-items:flex-end">
                          <button>Extension action</button>
                        </div>
                      </Show>
                    </SessionEmptyView>
                  </Show>
                </div>
              </ConversationPresentation>
            )}
          />
        )
      if (part === "composer")
        return (
          <HostView
            render={() => (
              <PromptDock
                context={composerLayout}
                pending={
                  <Show when={pending()}>
                    <div style="height:80px">Pending task</div>
                  </Show>
                }
              />
            )}
          />
        )
    },
  }
  return (
    <MarkedProvider>
      <style>{`html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}.fixture-controls{flex:none}`}</style>
      <div class="fixture-controls">
        <button data-expand onClick={() => (state.expanded ? state.collapse() : state.expand())}>
          Expand
        </button>
        <button data-resize onClick={() => state.setHeight(state.manualHeight === undefined ? 240 : undefined)}>
          Resize
        </button>
        <button data-attach onClick={() => setAttached(!attached())}>
          Attachment
        </button>
        <button data-pending-toggle onClick={() => setPending(!pending())}>
          Pending
        </button>
        <button data-conversation-toggle onClick={() => setWelcome(!welcome())}>
          Conversation
        </button>
        <button data-extension-toggle onClick={() => setExtension(!extension())}>
          Extension
        </button>
        <button data-games-toggle onClick={() => setGames(!games())}>
          Games
        </button>
      </div>
      <div style="flex:1;min-height:0">
        <DefaultSession context={{ layout }} />
      </div>
    </MarkedProvider>
  )
}
