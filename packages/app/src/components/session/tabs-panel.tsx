import { For, Show, createMemo } from "solid-js"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { DiffChanges } from "@ericsanchezok/synergy-ui/diff-changes"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import type { useFile } from "@/context/file"
import type { useLayout } from "@/context/layout"
import type { useCommand } from "@/context/command"
import type { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { usePrompt } from "@/context/prompt"
import type { useSync } from "@/context/sync"
import type { SelectedLineRange } from "@/context/file"
import type { FileDiff, Message, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { SessionContextTab } from "./session-context-tab"
import { SessionContextUsage } from "./session-context-usage"
import { SessionReviewTab } from "./session-review-tab"
import { SortableTab, FileVisual } from "./session-sortable-tab"
import { DialogSelectFile } from "@/components/dialog"
import { FileTabContent } from "./file-tab-content"

export interface TabsPanelProps {
  activeTab: () => string
  openTab: (value: string) => void
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  file: ReturnType<typeof useFile>
  prompt: ReturnType<typeof usePrompt>
  command: ReturnType<typeof useCommand>
  dialog: ReturnType<typeof useDialog>
  reviewTab: () => boolean
  contextOpen: () => boolean
  openedTabs: () => string[]
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
  diffs: () => FileDiff[]
  diffsReady: () => boolean
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  handleDragStart: (event: unknown) => void
  handleDragOver: (event: DragEvent) => void
  handleDragEnd: () => void
  activeDraggable: string | undefined
  handoffFiles: Record<string, SelectedLineRange | null>
}

export function TabsPanel(props: TabsPanelProps) {
  return (
    <div class="relative flex-1 min-w-0 h-full border-l border-border-weak-base">
      <DragDropProvider
        onDragStart={props.handleDragStart}
        onDragEnd={props.handleDragEnd}
        onDragOver={props.handleDragOver}
        collisionDetector={closestCenter}
      >
        <DragDropSensors />
        <ConstrainDragYAxis />
        <Tabs value={props.activeTab()} onChange={props.openTab} variant="pill">
          <div class="sticky top-0 shrink-0 flex items-center justify-between px-3 h-[48px] z-20 bg-background-stronger">
            <div class="flex-1 min-w-0 flex items-center overflow-hidden">
              <Tabs.List class="shadow-none">
                <Show when={props.reviewTab()}>
                  <Tabs.Trigger value="review">
                    <div class="flex items-center gap-2">
                      <Show when={props.diffs()}>
                        <DiffChanges changes={props.diffs()} variant="bars" />
                      </Show>
                      <div class="flex items-center gap-1.5">
                        <span>Review</span>
                        <Show when={props.info()?.summary?.files}>
                          <div class="text-11-medium text-text-strong h-[18px] px-1.5 flex flex-col items-center justify-center rounded-md bg-background-base shadow-[inset_0_0_0_1px_var(--border-weak-base)]">
                            {props.info()?.summary?.files ?? 0}
                          </div>
                        </Show>
                      </div>
                    </div>
                  </Tabs.Trigger>
                </Show>
                <Show when={props.contextOpen()}>
                  <Tabs.Trigger
                    value="context"
                    closeButton={
                      <Tooltip value="Close tab" placement="bottom">
                        <IconButton icon="x" variant="ghost" onClick={() => props.tabs().close("context")} />
                      </Tooltip>
                    }
                    hideCloseButton
                    onMiddleClick={() => props.tabs().close("context")}
                  >
                    <div class="flex items-center gap-2">
                      <SessionContextUsage variant="indicator" />
                      <span>Context</span>
                    </div>
                  </Tabs.Trigger>
                </Show>
                <SortableProvider ids={props.openedTabs()}>
                  <For each={props.openedTabs()}>
                    {(tab) => <SortableTab tab={tab} onTabClose={props.tabs().close} />}
                  </For>
                </SortableProvider>
              </Tabs.List>
            </div>

            <div class="shrink-0 flex items-center justify-center h-full px-1">
              <TooltipKeybind title="Open file" keybind={props.command.keybind("file.open")} placement="left">
                <IconButton
                  icon="plus"
                  variant="ghost"
                  class="!size-7 !rounded-lg"
                  iconSize="normal"
                  onClick={() => props.dialog.show(() => <DialogSelectFile />)}
                />
              </TooltipKeybind>
            </div>
          </div>
          <Show when={props.reviewTab()}>
            <Tabs.Content
              value="review"
              class="flex flex-col h-full overflow-hidden contain-strict bg-background-stronger"
            >
              <Show when={props.activeTab() === "review"}>
                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                  <Show
                    when={props.diffsReady()}
                    fallback={<div class="px-6 py-4 text-text-weak">Loading changes...</div>}
                  >
                    <SessionReviewTab
                      diffs={props.diffs}
                      view={props.view}
                      diffStyle={props.layout.review.diffStyle()}
                      onDiffStyleChange={props.layout.review.setDiffStyle}
                      onViewFile={(path) => {
                        const value = props.file.tab(path)
                        props.tabs().open(value)
                        props.file.load(path)
                      }}
                    />
                  </Show>
                </div>
              </Show>
            </Tabs.Content>
          </Show>
          <Show when={props.contextOpen()}>
            <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
              <Show when={props.activeTab() === "context"}>
                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                  <SessionContextTab
                    messages={props.messages}
                    visibleUserMessages={props.visibleUserMessages}
                    view={props.view}
                    info={props.info}
                  />
                </div>
              </Show>
            </Tabs.Content>
          </Show>
          <For each={props.openedTabs()}>
            {(tab) => (
              <FileTabContent
                tab={tab}
                isActive={() => props.activeTab() === tab}
                file={props.file}
                view={props.view}
                prompt={props.prompt}
                handoffFiles={props.handoffFiles}
              />
            )}
          </For>
        </Tabs>
        <DragOverlay>
          <Show when={props.activeDraggable}>
            {(tab) => {
              const path = createMemo(() => props.file.pathFromTab(tab()))
              return (
                <div class="relative px-6 h-12 flex items-center bg-background-stronger border-x border-border-weak-base border-b border-b-transparent">
                  <Show when={path()}>{(p) => <FileVisual active path={p()} />}</Show>
                </div>
              )
            }}
          </Show>
        </DragOverlay>
      </DragDropProvider>
    </div>
  )
}
