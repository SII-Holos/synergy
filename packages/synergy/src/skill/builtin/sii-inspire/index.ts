import CONTENT from "./content.txt"
import PLATFORM_GUIDE from "./references/platform-guide.txt"
import TROUBLESHOOTING from "./references/troubleshooting.txt"
import DISTRIBUTED_TRAINING from "./references/distributed-training.txt"
import { Config } from "../../../config/config"

export const siiInspire = {
  name: "sii-inspire",
  description:
    "SII 启智平台 GPU cluster tools for autonomous research. Covers: task submission (GPU/HPC), image management (Harbor), resource monitoring, and platform troubleshooting. Triggers: '启智', 'inspire', 'submit job', 'GPU training', '提交任务', '训练任务', 'docker image', '镜像', 'HPC', 'check GPU', '查看资源'.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/platform-guide.txt": PLATFORM_GUIDE,
    "references/troubleshooting.txt": TROUBLESHOOTING,
    "references/distributed-training.txt": DISTRIBUTED_TRAINING,
  },
  condition: async () => {
    const config = await Config.get()
    return config.sii?.enable === true
  },
}
