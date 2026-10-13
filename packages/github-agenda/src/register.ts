import watchDescription from "./watch-description.txt"
import scheduleDescription from "./schedule-description.txt"
import { AgendaGithubSource } from "@ericsanchezok/synergy-agenda/agenda/github-source"
import { AgendaGithubTrigger } from "./github-trigger"
import { GithubWatchPreflight } from "./preflight"
import { GithubWatchPolicy } from "@ericsanchezok/synergy-agenda/agenda/github-watch-policy"
import { readConfig } from "@ericsanchezok/synergy-github/config-schema"
export function registerBridge() {
  AgendaGithubSource.registerSource({
    ...AgendaGithubTrigger,
    descriptions: { watch: watchDescription, schedule: scheduleDescription },
    check: GithubWatchPreflight.check,
  })
  GithubWatchPolicy.register(async () => {
    const watch = (await readConfig()).github?.watch
    return { enabled: watch?.enabled !== false, defaultIntervalMs: watch?.defaultIntervalMs }
  })
}
