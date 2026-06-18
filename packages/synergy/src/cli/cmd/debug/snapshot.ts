import { Snapshot } from "../../../session/snapshot"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const SnapshotCommand = cmd({
  command: "snapshot",
  describe: "snapshot debugging utilities",
  builder: (yargs) => yargs.command(TrackCommand).command(PatchCommand).command(DiffCommand).demandCommand(),
  async handler() {},
})

const TrackCommand = cmd({
  command: "track",
  describe: "track current snapshot state",
  builder: (yargs) =>
    yargs.option("session", { type: "string", description: "Session ID for per-session snapshot isolation" }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      console.log(await Snapshot.track(args.session ?? "default"))
    })
  },
})

const PatchCommand = cmd({
  command: "patch <hash>",
  describe: "show patch for a snapshot hash",
  builder: (yargs) =>
    yargs
      .positional("hash", {
        type: "string",
        description: "hash",
        demandOption: true,
      })
      .option("session", { type: "string", description: "Session ID for per-session snapshot isolation" }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      console.log(await Snapshot.patch(args.hash, args.session ?? "default"))
    })
  },
})

const DiffCommand = cmd({
  command: "diff <hash>",
  describe: "show diff for a snapshot hash",
  builder: (yargs) =>
    yargs
      .positional("hash", {
        type: "string",
        description: "hash",
        demandOption: true,
      })
      .option("session", { type: "string", description: "Session ID for per-session snapshot isolation" }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      console.log(await Snapshot.diff(args.hash, args.session ?? "default"))
    })
  },
})
