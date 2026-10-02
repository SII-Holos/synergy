import type { WelcomeSceneDefinition } from "./types"

export const welcomeScenes: readonly WelcomeSceneDefinition[] = [
  {
    id: "island",
    title: { id: "welcome.island.title", message: "Make a connection. Watch it come alive." },
    load: () => import("./island/scene"),
  },
]
