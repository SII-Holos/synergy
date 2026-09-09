import type { Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { z } from "zod"
import { Persist, persisted } from "@/utils/persist"

const ShellPreferences = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), z.string().min(1)),
})

export function createShellPreference(server: Accessor<string>, kind: "shell" | "skin" = "shell") {
  const initial: z.infer<typeof ShellPreferences> = { version: 1, servers: {} }
  const [state, setState] = persisted(
    {
      ...Persist.global(`plugin-${kind}s`),
      migrate: (value) => ShellPreferences.safeParse(value).data ?? initial,
    },
    createStore(initial),
  )
  return {
    selected: () => state.servers[server()] ?? "synergy",
    select: (id: string) => setState("servers", server(), id),
  }
}
