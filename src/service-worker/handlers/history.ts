import type { ServiceWorkerHandlerMap } from "../shared";

export const historyHandlers: ServiceWorkerHandlerMap = {
  "history.list": async (message) => {
    const limit = typeof message.limit === "number" ? message.limit : 20;
    const items = await chrome.history.search({
      text: "",
      maxResults: limit,
      startTime: 0,
    });

    return {
      history: items.map((item) => ({
        url: item.url,
        title: item.title,
        lastVisitTime: item.lastVisitTime,
        visitCount: item.visitCount,
      })),
    };
  },

  "history.search": async (message) => {
    const query = message.query || "";
    const limit = typeof message.limit === "number" ? message.limit : 20;
    const items = (await chrome.history.search({
      text: query,
      maxResults: limit,
      startTime: 0,
    })) as chrome.history.HistoryItem[];

    return {
      history: items.map((item) => ({
        url: item.url,
        title: item.title,
        lastVisitTime: item.lastVisitTime,
        visitCount: item.visitCount,
      })),
    };
  },
};
