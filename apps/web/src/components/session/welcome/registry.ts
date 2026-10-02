import type { WelcomeSceneDefinition } from "./types"

export const welcomeScenes: readonly WelcomeSceneDefinition[] = [
  { id: "stack", title: { id: "welcome.stack.name", message: "Tiny tower" }, load: () => import("./stack/scene") },
  { id: "orbit", title: { id: "welcome.orbit.name", message: "Gravity post" }, load: () => import("./orbit/scene") },
  {
    id: "blocks",
    title: { id: "welcome.blocks.name", message: "Falling blocks" },
    load: () => import("./blocks/scene"),
  },
  {
    id: "flight",
    title: { id: "welcome.flight.name", message: "Pixel squadron" },
    load: () => import("./flight/scene"),
  },
]
