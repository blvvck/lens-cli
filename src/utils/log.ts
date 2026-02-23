const PREFIX = "[Lens]";
const PREVIEW_LIMIT = 200;
const state: { enabled: boolean; ready: boolean; queued: unknown[][] } = {
  enabled: false,
  ready: false,
  queued: [],
};
const flush = (): void => {
  const entries = state.queued.splice(0);
  if (state.enabled) entries.forEach((entry) => console.log(PREFIX, ...entry));
};
const onInitialSettings = (stored: { debugMode?: unknown }): void => {
  state.enabled = Boolean(stored.debugMode);
  state.ready = true;
  flush();
};
const onStorageChange = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void => {
  if (area === "local" && changes.debugMode) state.enabled = Boolean(changes.debugMode.newValue);
};
void chrome.storage.local.get("debugMode").then(onInitialSettings);
chrome.storage.onChanged.addListener(onStorageChange);
export const debugLog = (...values: unknown[]): void => {
  if (!state.ready) {
    state.queued.push(values);
    return undefined;
  };
  if (state.enabled) console.log(PREFIX, ...values);
};
export const isDebugMode = (): boolean => state.enabled;
export const previewDebugValue = (value: unknown, maxLen = PREVIEW_LIMIT): string => {
  if (typeof value === "string") return value.slice(0, maxLen);
  if (value === undefined) return "[undefined]";
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `[unserializable: ${reason}]`;
  };
  if (typeof serialized !== "string") return `[${typeof value}]`;
  return serialized.slice(0, maxLen);
};
