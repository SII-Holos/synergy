import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Panel } from "@/components/panel"

export function LucidPanel() {
  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <Panel.Title>Lucid</Panel.Title>
          <span class="text-11-regular text-text-weaker border border-border-base/40 px-2 py-0.5 rounded-md">
            Coming soon
          </span>
        </Panel.HeaderRow>
      </Panel.Header>

      <Panel.Body>
        <div class="flex flex-col items-center text-center pt-12 pb-8 px-4">
          <div class="relative mb-8">
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
    </Panel.Root>
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
