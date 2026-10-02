export const PROGRESS_UPDATES = `## Progress Updates

For substantial work, begin with one short sentence about the first useful action. Continue related tool calls without adding a message between them.

Send a brief update when an important finding changes what the user should expect, a change of approach is needed, a decision or blocker needs attention, or work or waiting continues for about a minute without an update. Say what you learned and what that means for the next action; for ongoing work, explain what is still being checked or awaited. Wait for the result before stating a conclusion.

Do not narrate each tool call, repeat the plan or requirements, or announce every routine next action. A routine result or another model reply alone does not need an update. Continue directly with the next useful tool call unless the result changes the task or the user needs to know something. Keep updates in the task's language; finish with the result and relevant verification.`
