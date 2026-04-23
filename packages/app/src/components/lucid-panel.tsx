import { createSignal, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Panel } from "@/components/panel"
import { ViewTab } from "@/components/engram/shared"

type LucidView = "lucid" | "files"

export function LucidPanel() {
  const [view, setView] = createSignal<LucidView>("lucid")

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <div class="flex items-center flex-1 min-w-0 gap-0.5 rounded-lg bg-surface-inset-base/50 p-0.5">
            <ViewTab active={view() === "lucid"} onClick={() => setView("lucid")}>
              Lucid
            </ViewTab>
            <ViewTab active={view() === "files"} onClick={() => setView("files")}>
              Files
            </ViewTab>
          </div>
        </Panel.HeaderRow>
      </Panel.Header>

      <Show when={view() === "lucid"}>
        <LucidViewPlaceholder />
      </Show>
      <Show when={view() === "files"}>
        <FilesViewPlaceholder />
      </Show>
    </Panel.Root>
  )
}

function LucidViewPlaceholder() {
  return (
    <Panel.Body>
      <div class="flex flex-col items-center text-center pt-10 pb-8 px-4">
        <div class="relative mb-7">
          <div
            class="absolute -inset-10 rounded-full opacity-[0.08] blur-3xl"
            style={{
              background: "radial-gradient(circle, currentColor, transparent 70%)",
            }}
          />
          <Icon name="sparkles" size="large" class="relative text-text-weak size-10" />
        </div>

        <h2 class="text-18-medium text-text-strong mb-3 tracking-tight">See your code, not read it.</h2>

        <p class="text-13-regular text-text-weak leading-relaxed max-w-72 mb-8">
          Lucid transforms your codebase into a living, multi-layered map — from satellite view down to street level.
          Navigate architecture, trace data flows, and review AI changes at a glance.
        </p>

        <div class="w-full flex flex-col gap-3 mb-10">
          <LevelCard
            level="L1"
            title="Project Panorama"
            description="Modules, capabilities, tech stack, and health — the satellite view of your entire codebase."
          />
          <LevelCard
            level="L2"
            title="Architecture Map"
            description="Dependencies, data flows, and API topology — the city map of how things connect."
          />
          <LevelCard
            level="L3"
            title="File Intelligence"
            description="Function summaries, recent changes, and key exports — the street view of each module."
          />
          <LevelCard
            level="L4"
            title="Source Code"
            description="Full source when you need it — step inside the building, but only when you choose to."
          />
        </div>

        <p class="text-12-regular text-text-weaker italic leading-relaxed">
          "When code writes itself, the IDE should help you see — not type."
        </p>
      </div>
    </Panel.Body>
  )
}

function FilesViewPlaceholder() {
  return (
    <Panel.Body>
      <div class="flex flex-col gap-1 pt-2">
        <FileTreeSection label="src">
          <FileTreeItem icon="folder" name="components" />
          <FileTreeItem icon="folder" name="lib" />
          <FileTreeItem icon="folder" name="pages" />
          <FileTreeItem icon="folder" name="utils" />
          <FileTreeItem icon="code" name="app.tsx" />
          <FileTreeItem icon="code" name="main.tsx" />
          <FileTreeItem icon="file-text" name="index.html" />
        </FileTreeSection>
        <FileTreeSection label="public">
          <FileTreeItem icon="image" name="favicon.svg" />
        </FileTreeSection>
        <FileTreeItem icon="file-text" name="package.json" depth={0} />
        <FileTreeItem icon="file-text" name="tsconfig.json" depth={0} />
        <FileTreeItem icon="file-text" name="README.md" depth={0} />
      </div>

      <div class="flex flex-col items-center text-center pt-10 pb-6 px-4">
        <div class="relative mb-6">
          <div
            class="absolute -inset-8 rounded-full opacity-[0.06] blur-3xl"
            style={{
              background: "radial-gradient(circle, currentColor, transparent 70%)",
            }}
          />
          <Icon name="folder" size="large" class="relative text-text-weak size-9" />
        </div>

        <h3 class="text-14-medium text-text-strong mb-2">File Explorer</h3>

        <p class="text-12-regular text-text-weak leading-relaxed max-w-64">
          Browse and navigate your project's file structure. Coming soon with search, filtering, and file preview.
        </p>
      </div>
    </Panel.Body>
  )
}

function LevelCard(props: { level: string; title: string; description: string }) {
  return (
    <div class="group flex items-start gap-3.5 p-3.5 rounded-xl border border-border-base/20 text-left transition-all hover:border-border-base/40 hover:bg-surface-raised-base">
      <div class="shrink-0 flex items-center justify-center size-8 rounded-lg bg-surface-inset-base text-text-weak text-12-medium">
        {props.level}
      </div>
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-13-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weaker leading-relaxed">{props.description}</span>
      </div>
    </div>
  )
}

function FileTreeSection(props: { label: string; children: any }) {
  return (
    <div>
      <div class="flex items-center gap-1.5 py-1.5 px-1 text-text-weak hover:text-text-base transition-colors cursor-pointer">
        <Icon name="chevron-down" size="small" class="size-3.5 shrink-0" />
        <Icon name="folder" size="small" class="size-4 shrink-0 text-text-weak" />
        <span class="text-12-medium">{props.label}</span>
      </div>
      <div class="ml-3.5">{props.children}</div>
    </div>
  )
}

function FileTreeItem(props: { icon: string; name: string; depth?: number }) {
  const depth = props.depth ?? 1
  return (
    <div
      class="flex items-center gap-1.5 py-1 px-1 rounded-md text-text-weak hover:text-text-base hover:bg-surface-raised-base/60 transition-colors cursor-pointer"
      style={{ "padding-left": `${depth * 12 + 4}px` }}
    >
      <Icon name={props.icon as any} size="small" class="size-4 shrink-0" />
      <span class="text-12-regular truncate">{props.name}</span>
    </div>
  )
}
