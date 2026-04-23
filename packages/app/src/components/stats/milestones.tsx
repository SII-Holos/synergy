import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"

export function Milestones(_props: { snapshot: StatsSnapshot }) {
  return (
    <section class="rounded-2xl bg-surface-inset-base/35 px-4 py-3">
      <div class="text-12-medium text-text-weak">Achievements (coming next)</div>
      <p class="mt-1 text-12-regular text-text-weakest">
        We’ll turn your long-term stats into unlockable milestones next.
      </p>
    </section>
  )
}
