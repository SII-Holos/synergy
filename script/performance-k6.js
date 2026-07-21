import http from "k6/http"
import { check, sleep } from "k6"

export const options = {
  vus: Number(__ENV.SYNERGY_K6_VUS || 8),
  duration: __ENV.SYNERGY_K6_DURATION || "30s",
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1000"],
  },
}

const baseUrl = __ENV.SYNERGY_PERF_BASE_URL || "http://127.0.0.1:5817"
const path = __ENV.SYNERGY_PERF_PATH || "/global/health"

export default function () {
  const response = http.get(`${baseUrl}${path}`)
  check(response, { "status is 2xx/3xx": (r) => r.status >= 200 && r.status < 400 })
  sleep(1)
}
