import type { ServiceWorkerHandlerMap } from "../shared";

export const bookmarkHandlers: ServiceWorkerHandlerMap = {
  "bookmark.add": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }

    const tab = await chrome.tabs.get(tabId);
    const createProps: { title: string; url?: string; parentId?: string } = {
      title: tab.title || "Untitled",
      url: tab.url,
    };

    if (message.folder) {
      const search = await chrome.bookmarks.search({ title: message.folder });
      const folder = search.find((bookmark) => !bookmark.url);
      if (folder) {
        createProps.parentId = folder.id;
      }
    }

    const bookmark = await chrome.bookmarks.create(createProps);
    return {
      success: true,
      bookmark: { id: bookmark.id, title: bookmark.title, url: bookmark.url },
    };
  },

  "bookmark.remove": async (message) => {
    const tabId = message.tabId;
    if (!tabId) {
      throw new Error("No tabId provided");
    }

    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) {
      throw new Error("Tab has no URL");
    }

    const bookmarks = await chrome.bookmarks.search({ url: tab.url });
    if (bookmarks.length === 0) {
      throw new Error("No bookmark found for this URL");
    }

    await chrome.bookmarks.remove(bookmarks[0].id);
    return { success: true };
  },

  "bookmark.list": async (message) => {
    const limit = typeof message.limit === "number" ? message.limit : 50;
    let bookmarks: chrome.bookmarks.BookmarkTreeNode[] = [];

    if (message.folder) {
      const search = await chrome.bookmarks.search({ title: message.folder });
      const folder = search.find((bookmark) => !bookmark.url);
      if (folder) {
        const children = await chrome.bookmarks.getChildren(folder.id);
        bookmarks = children.filter((bookmark) => bookmark.url).slice(0, limit);
      }
    } else {
      bookmarks = await chrome.bookmarks.getRecent(limit);
    }

    return {
      bookmarks: bookmarks.map((bookmark) => ({
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        dateAdded: bookmark.dateAdded,
      })),
    };
  },
};
