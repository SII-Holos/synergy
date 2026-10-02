import type { WelcomeSceneDefinition } from "./types"

export const welcomeScenes: readonly WelcomeSceneDefinition[] = [
  { id: "chain", title: { id: "welcome.chain.name", message: "Chain sparks" }, load: () => import("./chain/scene") },
  { id: "stack", title: { id: "welcome.stack.name", message: "Tiny tower" }, load: () => import("./stack/scene") },
  { id: "orbit", title: { id: "welcome.orbit.name", message: "Gravity post" }, load: () => import("./orbit/scene") },
]
