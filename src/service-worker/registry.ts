import type { ServiceWorkerHandlerMap } from "./types";
import { bookmarkHandlers } from "./handlers/bookmarks";
import { canvasHandlers } from "./handlers/canvas";
import { consoleNetworkHandlers } from "./handlers/console-network";
import { cookieHandlers } from "./handlers/cookies";
import { dialogHandlers } from "./handlers/dialogs";
import { emulationHandlers } from "./handlers/emulation";
import { fetchInterceptHandlers } from "./handlers/fetch-intercept";
import { frameHandlers } from "./handlers/frames";
import { historyHandlers } from "./handlers/history";
import { indicatorHandlers } from "./handlers/indicators";
import { inputHandlers } from "./handlers/input";
import { miscHandlers } from "./handlers/misc";
import { nativeHostHandlers } from "./handlers/native-host";
import { pageHandlers } from "./handlers/page";
import { perfHandlers } from "./handlers/perf";
import { reloadHandlers } from "./handlers/reload";
import { tabHandlers } from "./handlers/tabs";
import { waitHandlers } from "./handlers/waits";
import { windowHandlers } from "./handlers/windows";

export const handlerRegistry: ServiceWorkerHandlerMap = {
  ...windowHandlers,
  ...tabHandlers,
  ...cookieHandlers,
  ...bookmarkHandlers,
  ...historyHandlers,
  ...emulationHandlers,
  ...perfHandlers,
  ...frameHandlers,
  ...fetchInterceptHandlers,
  ...pageHandlers,
  ...canvasHandlers,
  ...waitHandlers,
  ...inputHandlers,
  ...consoleNetworkHandlers,
  ...dialogHandlers,
  ...indicatorHandlers,
  ...miscHandlers,
  ...reloadHandlers,
  ...nativeHostHandlers,
};
