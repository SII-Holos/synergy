import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("workflows", [
    {
      id: "agenda",
      title: "Agenda",
      description:
        "Time-based scheduling and deferred execution. Set one-time wake-ups to continue work after a delay (agenda_watch), create recurring tasks that run in fresh sessions (agenda_schedule), list/inspect/update/cancel scheduled items, manually trigger runs, and review execution logs.",
      whenToExpand:
        "Expand in these high-frequency scenarios. (1) The user says 'remind me in X minutes' or 'check back later' — use agenda_watch instead of blocking the turn. (2) You need to defer a follow-up so the user is not held hostage to a long-running session: set a watch to resume after background work completes. (3) The user wants a recurring task: daily summaries, weekly reports, periodic checks, cron-like automation. (4) The task requires multi-session orchestration or you want to split a long effort across time. (5) The user asks to list, update, cancel, or manually trigger a scheduled task. (6) You are investigating whether a scheduled task ran or need to read its execution log. (7) The user asks about 'schedule', 'reminder', 'wake me up', 'every day', 'every week', 'later today', 'in an hour', 'recurring', or 'check back'.",
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
