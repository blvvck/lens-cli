import type { ServiceWorkerHandlerMap } from "../shared";
import { inputHandlers } from "./input";

export const indicatorHandlers: ServiceWorkerHandlerMap = {
  "lens.indicator.showStaticIndicator": inputHandlers["lens.indicator.showStaticIndicator"],
  "lens.indicator.hideStaticIndicator": inputHandlers["lens.indicator.hideStaticIndicator"],
  "lens.indicator.dismissStaticIndicator": inputHandlers["lens.indicator.dismissStaticIndicator"],
  "lens.indicator.showAgentIndicators": inputHandlers["lens.indicator.showAgentIndicators"],
  "lens.indicator.hideAgentIndicators": inputHandlers["lens.indicator.hideAgentIndicators"],
  "lens.indicator.heartbeat": inputHandlers["lens.indicator.heartbeat"],
  "lens.agent.stop": inputHandlers["lens.agent.stop"],
};
