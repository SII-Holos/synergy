import { Component, createMemo, JSX, Show } from "solid-js"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { useLocal, type LocalModel } from "@/context/local"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Tag } from "@ericsanchezok/synergy-ui/tag"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { List } from "@ericsanchezok/synergy-ui/list"
import { DialogSelectProvider } from "./dialog-select-provider"

function sortGroups(a: { category: string; items: LocalModel[] }, b: { category: string; items: LocalModel[] }) {
  if (a.category === "Recent" && b.category !== "Recent") return -1
  if (b.category === "Recent" && a.category !== "Recent") return 1

  const aProvider = a.items[0]?.provider.id
  const bProvider = b.items[0]?.provider.id
  if (!aProvider || !bProvider) return a.category.localeCompare(b.category)
  if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
  if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
  return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
}

function ModelRow(props: { model: LocalModel; compact?: boolean }) {
  const showFree =
    (props.model.cost?.input ?? 0) === 0 &&
    (props.model.cost?.output ?? 0) === 0 &&
    !props.model.name.toLowerCase().includes("free")

  return (
    <div class="w-full min-w-0 flex items-center gap-x-2 text-left text-13-regular">
      <span class="min-w-0 truncate flex-1">{props.model.name}</span>
      <Show when={showFree}>
        <Tag>Free</Tag>
      </Show>
      <Show when={!props.compact && props.model.latest}>
        <Tag>Latest</Tag>
      </Show>
    </div>
  )
}

type QuickSwitcherEntry = LocalModel & {
  group: string
  listKey: string
}

const QuickSwitcherList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
}> = (props) => {
  const local = useLocal()

  const models = createMemo<QuickSwitcherEntry[]>(() => {
    const filtered = local.model
      .quickSwitcher()
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .sort((a, b) => a.name.localeCompare(b.name))

    const entries = filtered.map((model) => ({
      ...model,
      group: model.provider.name,
      listKey: `${model.provider.id}:${model.id}`,
    }))

    const recentEntries = local.model
      .recent()
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .filter((model) => filtered.some((item) => item.provider.id === model.provider.id && item.id === model.id))
      .map((model) => ({
        ...model,
        group: "Recent",
        listKey: `recent:${model.provider.id}:${model.id}`,
      }))

    return [...recentEntries, ...entries]
  })

  const current = createMemo<QuickSwitcherEntry | undefined>(() => {
    const selected = local.model.current()
    if (!selected) return undefined
    return models().find((model) => model.provider.id === selected.provider.id && model.id === selected.id)
  })

  return (
    <List<QuickSwitcherEntry>
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: "Search models", autofocus: true }}
      emptyMessage="No quick-switch models"
      key={(x) => x.listKey}
      items={models}
      current={current()}
      filterKeys={["provider.name", "name", "id"]}
      groupBy={(x) => x.group}
      sortGroupsBy={sortGroups}
      onSelect={(x) => {
        if (!x) return
        local.model.set({ modelID: x.id, providerID: x.provider.id }, { recent: true })
        props.onSelect?.()
      }}
    >
      {(model) => <ModelRow model={model} compact />}
    </List>
  )
}

const ConnectedModelManager: Component<{
  provider?: string
  onSelect?: () => void
}> = (props) => {
  const local = useLocal()

  const models = createMemo(() =>
    local.model
      .all()
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  return (
    <List
      search={{ placeholder: "Search models", autofocus: true }}
      emptyMessage="No connected model results"
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={local.model.current()}
      filterKeys={["provider.name", "name", "id"]}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={sortGroups}
      onSelect={(x) => {
        if (!x) return
        local.model.set({ modelID: x.id, providerID: x.provider.id }, { recent: true })
        props.onSelect?.()
      }}
    >
      {(model) => (
        <div class="w-full flex items-center justify-between gap-x-3">
          <ModelRow model={model} />
          <div class="flex items-center gap-x-3 shrink-0" onClick={(e) => e.stopPropagation()}>
            <span class="text-12-regular text-text-weak">Quick</span>
            <Switch
              checked={local.model.inQuickSwitcher({ modelID: model.id, providerID: model.provider.id })}
              onChange={(checked) => {
                local.model.setQuickSwitcher({ modelID: model.id, providerID: model.provider.id }, checked)
              }}
            />
          </div>
        </div>
      )}
    </List>
  )
}

export const ModelSelectorPopover: Component<{
  provider?: string
  children: JSX.Element
}> = (props) => {
  const dialog = useDialog()

  return (
    <ToolbarSelectorPopover trigger={props.children} title="Select model" contentClass="w-[28rem] h-96">
      {(close) => (
        <div class="flex h-full min-h-0 flex-col p-1">
          <QuickSwitcherList provider={props.provider} onSelect={close} />
          <div class="px-2 pb-2 pt-1 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-base"
              onClick={() => {
                close()
                dialog.show(() => <DialogSelectModel provider={props.provider} />)
              }}
            >
              Manage models
            </Button>
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-weak"
              onClick={() => {
                close()
                dialog.show(() => <DialogSelectProvider />)
              }}
            >
              Connect provider
            </Button>
          </div>
        </div>
      )}
    </ToolbarSelectorPopover>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialog = useDialog()

  return (
    <Dialog
      title="Manage models"
      description="Choose which connected models appear in quick switcher, or select one to use now."
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon="plus"
          tabIndex={-1}
          onClick={() => dialog.show(() => <DialogSelectProvider />)}
        >
          Connect provider
        </Button>
      }
    >
      <div class="flex flex-col gap-4 min-h-0">
        <div class="px-3 text-12-regular text-text-weak">All models from your currently connected providers.</div>
        <ConnectedModelManager provider={props.provider} onSelect={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
