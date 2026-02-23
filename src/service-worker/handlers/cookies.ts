import type { ServiceWorkerHandlerMap, ServiceWorkerMessage } from "../shared";

type CookieGetResult = { cookie: chrome.cookies.Cookie } | { error: string };
type CookieSetResult = { success: true; cookie: chrome.cookies.Cookie | null };
type CookieClearResult = { success: true; cleared: string | number };

function requireTabId(message: ServiceWorkerMessage): number {
  if (!message.tabId) {
    throw new Error("No tabId provided");
  }
  return message.tabId;
}

async function resolveTabUrl(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) {
    throw new Error("Tab has no URL");
  }
  return tab.url;
}

export const cookieHandlers: ServiceWorkerHandlerMap = {
  "cookie.list": async (message) => {
    const tabId = requireTabId(message);
    const url = await resolveTabUrl(tabId);
    const cookies = await chrome.cookies.getAll({ url });
    return { cookies };
  },

  "cookie.get": async (message): Promise<CookieGetResult> => {
    const tabId = requireTabId(message);
    if (!message.name) {
      throw new Error("Cookie name required");
    }

    const url = await resolveTabUrl(tabId);
    const cookie = await chrome.cookies.get({ url, name: message.name });
    if (!cookie) {
      return { error: `Cookie "${message.name}" not found` };
    }

    return { cookie };
  },

  "cookie.set": async (message): Promise<CookieSetResult> => {
    const tabId = requireTabId(message);
    if (!message.name) {
      throw new Error("Cookie name required");
    }
    if (message.value === undefined) {
      throw new Error("Cookie value required");
    }

    const url = await resolveTabUrl(tabId);

    const cookieDetails: chrome.cookies.SetDetails = {
      url,
      name: message.name,
      value: String(message.value ?? ""),
    };

    if (message.expires) {
      const expirationDate = new Date(message.expires).getTime() / 1000;
      if (Number.isNaN(expirationDate)) {
        throw new Error(`Invalid expiration date: ${message.expires}`);
      }
      cookieDetails.expirationDate = expirationDate;
    }

    const result = await chrome.cookies.set(cookieDetails);
    return { success: true, cookie: result };
  },

  "cookie.clear": async (message): Promise<CookieClearResult> => {
    const tabId = requireTabId(message);
    if (!message.name) {
      throw new Error("Cookie name required");
    }

    const url = await resolveTabUrl(tabId);
    await chrome.cookies.remove({ url, name: message.name });
    return { success: true, cleared: message.name };
  },

  "cookie.clearAll": async (message) => {
    const tabId = requireTabId(message);
    const url = await resolveTabUrl(tabId);

    const cookies = await chrome.cookies.getAll({ url });
    for (const cookie of cookies) {
      await chrome.cookies.remove({ url, name: cookie.name });
    }

    return { success: true, cleared: cookies.length };
  },
};
