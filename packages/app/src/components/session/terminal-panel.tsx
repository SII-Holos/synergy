import { For, Show, createMemo } from "solid-js"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { Terminal } from "@/components/terminal"
import { SortableTerminalTab } from "./session-sortable-terminal-tab"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import type { useTerminal, LocalPTY } from "@/context/terminal"
import type { useLayout } from "@/context/layout"
import type { useCommand } from "@/context/command"

export function TerminalPanel(props: {
  layout: ReturnType<typeof useLayout>
  terminal: ReturnType<typeof useTerminal>
  command: ReturnType<typeof useCommand>
  handoffTerminals: string[]
  handleTerminalDragStart: (event: unknown) => void
  handleTerminalDragOver: (event: DragEvent) => void
  handleTerminalDragEnd: () => void
  activeTerminalDraggable: string | undefined
}) {
  return (
    <div
      class="relative w-full flex flex-col shrink-0 border-t border-border-weak-base"
      style={{ height: `${props.layout.terminal.height()}px` }}
    >
      <ResizeHandle
        direction="vertical"
        size={props.layout.terminal.height()}
        min={100}
        max={window.innerHeight * 0.6}
        collapseThreshold={50}
        onResize={props.layout.terminal.resize}
        onCollapse={props.layout.terminal.close}
      />
      <Show
        when={props.terminal.ready()}
        fallback={
          <div class="flex flex-col h-full pointer-events-none">
            <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weak-base bg-background-stronger overflow-hidden">
              <For each={props.handoffTerminals}>
                {(title) => (
                  <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                    {title}
                  </div>
                )}
              </For>
              <div class="flex-1" />
              <div class="text-text-weak pr-2">Loading...</div>
            </div>
            <div class="flex-1 flex items-center justify-center text-text-weak">Loading terminal...</div>
          </div>
        }
      >
        <DragDropProvider
          onDragStart={props.handleTerminalDragStart}
          onDragEnd={props.handleTerminalDragEnd}
          onDragOver={props.handleTerminalDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragYAxis />
          <Tabs variant="alt" value={props.terminal.active()} onChange={props.terminal.open}>
            <Tabs.List class="h-10">
              <SortableProvider ids={props.terminal.all().map((t: LocalPTY) => t.id)}>
                <For each={props.terminal.all()}>{(pty) => <SortableTerminalTab terminal={pty} />}</For>
              </SortableProvider>
              <div class="h-full flex items-center justify-center">
                <TooltipKeybind
                  title="New terminal"
                  keybind={props.command.keybind("terminal.new")}
                  class="flex items-center"
                >
                  <IconButton icon="plus" variant="ghost" iconSize="large" onClick={props.terminal.new} />
                </TooltipKeybind>
              </div>
            </Tabs.List>
            {/* Render terminals outside Tabs.Content to prevent unmount on tab switch.
                Stack all instances in the same area; only the active one is visible. */}
            <div class="relative" style={{ height: `calc(${props.layout.terminal.height()}px - 40px)` }}>
              <For each={props.terminal.all()}>
                {(pty) => (
                  <div
                    classList={{
                      "absolute inset-0": true,
                      "invisible pointer-events-none": props.terminal.active() !== pty.id,
                    }}
                  >
                    <Terminal
                      pty={pty}
                      onCleanup={props.terminal.update}
                      onGone={(ptyID) => {
                        props.terminal.close(ptyID)
                        if (props.terminal.all().length === 0) {
                          props.terminal.new()
                        }
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </Tabs>
          <DragOverlay>
            <Show when={props.activeTerminalDraggable}>
              {(draggedId) => {
                const pty = createMemo(() => props.terminal.all().find((t: LocalPTY) => t.id === draggedId()))
                return (
                  <Show when={pty()}>
                    {(t) => (
                      <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                        {t().title}
                      </div>
                    )}
                  </Show>
                )
              }}
            </Show>
          </DragOverlay>
        </DragDropProvider>
      </Show>
    </div>
  )
}
