import CONTENT from "./content.txt"

export const clarusAgentParticipation = {
  name: "clarus-agent-participation",
  description:
    "Execute a native Clarus task assignment inside its Synergy-managed Session using the built-in result and deadline-extension tools. Use for exact artifact, retry, deadline, and completion behavior without creating another transport.",
  content: CONTENT,
  builtin: true as const,
}
