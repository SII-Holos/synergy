import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { InspireAuth } from "../../tool/inspire/auth"

export const SiiCommand = cmd({
  command: "sii",
  describe: "SII 启智平台 integration",
  builder: (yargs) => yargs.command(SiiInspireCommand).command(SiiHarborCommand).demandCommand(),
  handler: () => {},
})

const SiiInspireCommand = cmd({
  command: "inspire",
  describe: "启智平台 account management",
  builder: (yargs) => yargs.command(SiiInspireLoginCommand).demandCommand(),
  handler: () => {},
})

const SiiInspireLoginCommand = cmd({
  command: "login",
  describe: "Configure 启智平台 credentials (学工号 + CAS 密码)",
  builder: (yargs) =>
    yargs
      .option("username", { type: "string", describe: "学工号" })
      .option("password", { type: "string", describe: "CAS 密码" }),
  async handler(args) {
    let username = args.username
    let password = args.password

    if (!username) {
      const result = await prompts.text({ message: "学工号" })
      if (prompts.isCancel(result)) throw new UI.CancelledError()
      username = result
    }
    if (!password) {
      const result = await prompts.password({ message: "CAS 密码" })
      if (prompts.isCancel(result)) throw new UI.CancelledError()
      password = result
    }

    await InspireAuth.saveInspireCredentials(username, password)

    const spinner = prompts.spinner()
    spinner.start("验证连接...")
    const ok = await InspireAuth.testInspireConnection()
    if (ok) {
      spinner.stop("✅ 启智平台认证成功")
    } else {
      spinner.stop("⚠️  凭证已保存，但连接验证失败（可能需要 VPN 或校园网环境）")
    }
  },
})

const SiiHarborCommand = cmd({
  command: "harbor",
  describe: "Harbor 镜像仓库 account management",
  builder: (yargs) => yargs.command(SiiHarborLoginCommand).demandCommand(),
  handler: () => {},
})

const SiiHarborLoginCommand = cmd({
  command: "login",
  describe: "Configure Harbor registry credentials",
  builder: (yargs) =>
    yargs
      .option("username", { type: "string", describe: "Harbor username (robot account)" })
      .option("password", { type: "string", describe: "Harbor password/key" }),
  async handler(args) {
    let username = args.username
    let password = args.password

    if (!username) {
      const result = await prompts.text({ message: "Harbor 用户名（robot$...）" })
      if (prompts.isCancel(result)) throw new UI.CancelledError()
      username = result
    }
    if (!password) {
      const result = await prompts.password({ message: "Harbor 密码" })
      if (prompts.isCancel(result)) throw new UI.CancelledError()
      password = result
    }

    await InspireAuth.saveHarborCredentials(username, password)

    const spinner = prompts.spinner()
    spinner.start("验证连接...")
    const ok = await InspireAuth.testHarborConnection()
    if (ok) {
      spinner.stop("✅ Harbor 镜像仓库认证成功 (docker-qb.sii.edu.cn)")
    } else {
      spinner.stop("⚠️  凭证已保存，但连接验证失败（可能需要 VPN 或校园网环境）")
    }
  },
})
