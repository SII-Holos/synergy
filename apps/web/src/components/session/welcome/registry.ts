import type { WelcomeSceneDefinition } from "./types"

export const welcomeScenes: readonly WelcomeSceneDefinition[] = [
  {
    id: "story",
    title: { id: "welcome.story.title", message: "This bookshop is waiting for you." },
    load: () => import("./story/scene"),
  },
  {
    id: "nature",
    title: { id: "welcome.nature.title", message: "Where will a little water take you?" },
    load: () => import("./nature/scene"),
  },
  {
    id: "island",
    title: { id: "welcome.island.title", message: "Make a connection. Watch it come alive." },
    load: () => import("./island/scene"),
  },
]
