import type { MessageDescriptor } from "@lingui/core"

export type StoryId = "arrival" | "foyer" | "letter" | "shelves" | "visitor" | "reunion" | "reading" | "voyage"
export type Story = { node: StoryId; history: StoryId[] }
export type StoryChoice = {
  id: string
  to: StoryId
  label: MessageDescriptor
  hotspot: "door" | "letter" | "books" | "visitor"
}
export type StoryNode = { title: MessageDescriptor; body: MessageDescriptor; choices: StoryChoice[]; ending?: boolean }

export const storyNodes: Record<StoryId, StoryNode> = {
  arrival: {
    title: { id: "welcome.story.arrivalTitle", message: "The last light on the coast" },
    body: {
      id: "welcome.story.arrivalBody",
      message:
        "The tide is coming in. At the end of the pier, a bookshop has left its door ajar. The sign says: stories welcome, even unfinished ones.",
    },
    choices: [
      {
        id: "enter",
        to: "foyer",
        hotspot: "door",
        label: { id: "welcome.story.enter", message: "Push open the door" },
      },
    ],
  },
  foyer: {
    title: { id: "welcome.story.foyerTitle", message: "A place to begin" },
    body: {
      id: "welcome.story.foyerBody",
      message:
        "A bell rings. Beside a sealed letter sits an atlas with salt-stained pages. Someone outside pauses at the window, looking for a familiar face.",
    },
    choices: [
      {
        id: "letter",
        to: "letter",
        hotspot: "letter",
        label: { id: "welcome.story.letter", message: "Read the letter" },
      },
      {
        id: "books",
        to: "shelves",
        hotspot: "books",
        label: { id: "welcome.story.books", message: "Explore the shelves" },
      },
      {
        id: "guest",
        to: "visitor",
        hotspot: "visitor",
        label: { id: "welcome.story.guest", message: "Invite the visitor in" },
      },
    ],
  },
  letter: {
    title: { id: "welcome.story.letterTitle", message: "A letter that waited" },
    body: {
      id: "welcome.story.letterBody",
      message:
        "“If the sea brings you home, I will be here.” There is no address, only a tiny lighthouse drawn in the corner. The visitor has the same lighthouse on a pendant.",
    },
    choices: [
      {
        id: "owner",
        to: "visitor",
        hotspot: "visitor",
        label: { id: "welcome.story.owner", message: "Ask about the pendant" },
      },
      {
        id: "atlas",
        to: "shelves",
        hotspot: "books",
        label: { id: "welcome.story.atlas", message: "Find the lighthouse on the map" },
      },
    ],
  },
  shelves: {
    title: { id: "welcome.story.shelvesTitle", message: "Between the pages" },
    body: {
      id: "welcome.story.shelvesBody",
      message:
        "The atlas opens to an island missing from every modern map. Tucked inside is a handwritten invitation: “Bring a story. We sail at dawn.” There are enough chairs here for a different kind of journey, too.",
    },
    choices: [
      {
        id: "map",
        to: "voyage",
        hotspot: "books",
        label: { id: "welcome.story.map", message: "Follow the invitation" },
      },
      {
        id: "reading",
        to: "reading",
        hotspot: "door",
        label: { id: "welcome.story.reading", message: "Host a night of stories" },
      },
    ],
  },
  visitor: {
    title: { id: "welcome.story.visitorTitle", message: "Someone has come home" },
    body: {
      id: "welcome.story.visitorBody",
      message:
        "“My sister used to keep this shop,” the visitor says. “She always left a light for me.” Their gaze settles on the letter. Outside, the rain begins to ease.",
    },
    choices: [
      {
        id: "return",
        to: "reunion",
        hotspot: "letter",
        label: { id: "welcome.story.return", message: "Give them the letter" },
      },
      {
        id: "journey",
        to: "shelves",
        hotspot: "books",
        label: { id: "welcome.story.journey", message: "Share the atlas" },
      },
    ],
  },
  reunion: {
    title: { id: "welcome.story.reunionTitle", message: "A light, kept for you" },
    body: {
      id: "welcome.story.reunionBody",
      message:
        "The visitor smiles before finishing the first line. Upstairs, a floorboard creaks. Two cups appear on the table. You step outside and leave the door open. Some stories end where they began.",
    },
    choices: [],
    ending: true,
  },
  reading: {
    title: { id: "welcome.story.readingTitle", message: "A room full of beginnings" },
    body: {
      id: "welcome.story.readingBody",
      message:
        "You turn the chairs toward the window. One neighbor brings a poem; another brings a tale with no ending. By midnight, every seat is taken. The smallest shop on the coast has become a whole world.",
    },
    choices: [],
    ending: true,
  },
  voyage: {
    title: { id: "welcome.story.voyageTitle", message: "A page beyond the horizon" },
    body: {
      id: "welcome.story.voyageBody",
      message:
        "At dawn, a small boat waits by the pier. You carry the atlas and an empty notebook. As the bookshop grows smaller behind you, a new island appears at the edge of the page.",
    },
    choices: [],
    ending: true,
  },
}

export function createStory(): Story {
  return { node: "arrival", history: [] }
}
export function chooseStory(state: Story, choiceId: string): Story {
  const choice = storyNodes[state.node].choices.find((candidate) => candidate.id === choiceId)
  return choice ? { node: choice.to, history: [...state.history, state.node].slice(-16) } : state
}
export function backStory(state: Story): Story {
  const node = state.history.at(-1)
  return node ? { node, history: state.history.slice(0, -1) } : state
}
