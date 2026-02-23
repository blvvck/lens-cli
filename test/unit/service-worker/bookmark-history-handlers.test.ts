import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

let handleMessage: (message: any, sender: any) => Promise<any>;

beforeAll(async () => {
  (globalThis as any).chrome = createChromeMock();
  handleMessage = (await import("../../../src/service-worker/main")).handleMessage;
});

describe("bookmark and history command dispatch", () => {
  beforeEach(() => {
    const chrome = createChromeMock() as any;
    chrome.bookmarks = {
      search: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockResolvedValue({ id: "new", title: "Example", url: "https://example.com" }),
      remove: vi.fn().mockResolvedValue(undefined),
      getChildren: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
    };
    chrome.history = { search: vi.fn().mockResolvedValue([]) };
    chrome.tabs.get.mockResolvedValue({ id: 12, title: "Example", url: "https://example.com" });
    (globalThis as any).chrome = chrome;
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("adds the current tab to a matching folder and returns the created bookmark", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.bookmarks.search.mockResolvedValue([{ id: "folder-1", title: "Saved", url: undefined }]);

    await expect(
      handleMessage({ type: "bookmark.add", tabId: 12, folder: "Saved" }, {}),
    ).resolves.toEqual({
      success: true,
      bookmark: { id: "new", title: "Example", url: "https://example.com" },
    });

    expect(chrome.bookmarks.create).toHaveBeenCalledWith({
      title: "Example",
      url: "https://example.com",
      parentId: "folder-1",
    });
  });

  it("removes the first bookmark matching the current tab URL", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.bookmarks.search.mockResolvedValue([
      { id: "bookmark-1", url: "https://example.com" },
      { id: "bookmark-2", url: "https://example.com" },
    ]);

    await expect(handleMessage({ type: "bookmark.remove", tabId: 12 }, {})).resolves.toEqual({
      success: true,
    });

    expect(chrome.bookmarks.remove).toHaveBeenCalledWith("bookmark-1");
  });

  it("lists URL bookmarks from a matching folder and applies the requested limit", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.bookmarks.search.mockResolvedValue([{ id: "folder-1", title: "Saved" }]);
    chrome.bookmarks.getChildren.mockResolvedValue([
      { id: "bookmark-1", title: "First", url: "https://one.example", dateAdded: 1 },
      { id: "folder-2", title: "Nested folder" },
      { id: "bookmark-2", title: "Second", url: "https://two.example", dateAdded: 2 },
    ]);

    await expect(
      handleMessage({ type: "bookmark.list", folder: "Saved", limit: 1 }, {}),
    ).resolves.toEqual({
      bookmarks: [{ id: "bookmark-1", title: "First", url: "https://one.example", dateAdded: 1 }],
    });

    expect(chrome.bookmarks.getChildren).toHaveBeenCalledWith("folder-1");
  });

  it("lists recent bookmarks with the default limit", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.bookmarks.getRecent.mockResolvedValue([
      { id: "bookmark-1", title: "First", url: "https://one.example", dateAdded: 1 },
    ]);

    await expect(handleMessage({ type: "bookmark.list" }, {})).resolves.toEqual({
      bookmarks: [{ id: "bookmark-1", title: "First", url: "https://one.example", dateAdded: 1 }],
    });

    expect(chrome.bookmarks.getRecent).toHaveBeenCalledWith(50);
  });

  it("lists history using an empty query and the default limit", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.history.search.mockResolvedValue([
      { url: "https://example.com", title: "Example", lastVisitTime: 10, visitCount: 3 },
    ]);

    await expect(handleMessage({ type: "history.list" }, {})).resolves.toEqual({
      history: [{ url: "https://example.com", title: "Example", lastVisitTime: 10, visitCount: 3 }],
    });

    expect(chrome.history.search).toHaveBeenCalledWith({ text: "", maxResults: 20, startTime: 0 });
  });

  it("searches history using the supplied query and limit", async () => {
    const chrome = (globalThis as any).chrome;
    chrome.history.search.mockResolvedValue([
      { url: "https://example.com", title: "Example", lastVisitTime: 10, visitCount: 3 },
    ]);

    await expect(
      handleMessage({ type: "history.search", query: "example", limit: 5 }, {}),
    ).resolves.toEqual({
      history: [{ url: "https://example.com", title: "Example", lastVisitTime: 10, visitCount: 3 }],
    });

    expect(chrome.history.search).toHaveBeenCalledWith({
      text: "example",
      maxResults: 5,
      startTime: 0,
    });
  });
});
