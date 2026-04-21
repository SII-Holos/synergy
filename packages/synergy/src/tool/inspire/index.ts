import { InspireStatusTool } from "./status"
import { InspireConfigTool } from "./config"
import { InspireImagesTool } from "./images"
import { InspireImagePushTool } from "./image-push"
import { InspireSubmitTool } from "./submit"
import { InspireSubmitHpcTool } from "./submit-hpc"
import { InspireInferenceTool } from "./inference"
import { InspireStopTool } from "./stop"
import { InspireJobsTool } from "./jobs"
import { InspireJobDetailTool } from "./job-detail"
import { InspireLogsTool } from "./logs"
import { InspireMetricsTool } from "./metrics"

export const InspireTools = [
  InspireStatusTool,
  InspireConfigTool,
  InspireImagesTool,
  InspireImagePushTool,
  InspireSubmitTool,
  InspireSubmitHpcTool,
  InspireInferenceTool,
  InspireStopTool,
  InspireJobsTool,
  InspireJobDetailTool,
  InspireLogsTool,
  InspireMetricsTool,
]
