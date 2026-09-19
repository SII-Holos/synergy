import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("workflows", [
    {
      id: "agenda",
      title: "Agenda",
      description:
        "Time-based scheduling, deferred execution, and GitHub event triggers. Set one-time wake-ups to continue work after a delay (agenda_watch), wake on a GitHub PR/issue/workflow/check state change (agenda_watch with onGithub), create recurring tasks that run in fresh sessions (agenda_schedule), list/inspect/update/cancel scheduled items, manually trigger runs, and review execution logs.",
      whenToExpand:
        "Expand in these high-frequency scenarios. (1) The user says 'remind me in X minutes' or 'check back later' — use agenda_watch instead of blocking the turn. (2) You need to defer a follow-up so the user is not held hostage to a long-running session: set a watch to resume after background work completes. (3) The user wants a recurring task: daily summaries, weekly reports, periodic checks, cron-like automation. (4) The task requires multi-session orchestration or you want to split a long effort across time. (5) The user asks to list, update, cancel, or manually trigger a scheduled task. (6) You are investigating whether a scheduled task ran or need to read its execution log. (7) The user asks about 'schedule', 'reminder', 'wake me up', 'every day', 'every week', 'later today', 'in an hour', 'recurring', or 'check back'. (8) The user wants to react to a GitHub event — 'tell me when PR #N merges', 'wake me if CI fails', 'ping me when the issue closes' — use agenda_watch(onGithub=...) or agenda_schedule with a github trigger instead of a timed delay plus manual shell checks. (9) You are about to schedule repeated timed shell checks of GitHub state — switch to the event-driven onGithub trigger instead.",
      tools: [
        "agenda_schedule",
        "agenda_watch",
        "agenda_list",
        "agenda_update",
        "agenda_cancel",
        "agenda_trigger",
        "agenda_logs",
      ],
    },
  ])
}
