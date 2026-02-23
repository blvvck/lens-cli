import { indicatorIds, injectIndicatorStyles } from "./styles";
const defaultHeartbeatMs = 10000;
let glow: HTMLDivElement | null = null;
let stop: HTMLDivElement | null = null;
let staticNotice: HTMLDivElement | null = null;
let active = false;
let staticActive = false;
let restoreActive = false;
let restoreStatic = false;
let heartbeat: number | null = null;
let heartbeatMs = defaultHeartbeatMs;
void chrome.storage.local.get("heartbeatInterval").then(({ heartbeatInterval }) => {
  if (typeof heartbeatInterval === "number" && heartbeatInterval) {
    heartbeatMs = heartbeatInterval * 1000;
  }
},);
chrome.storage.onChanged.addListener((changes, area) => {
  const next = changes.heartbeatInterval?.newValue;
  if (area !== "local" || typeof next !== "number" || !next) return;
  heartbeatMs = next * 1000;
  if (staticActive && heartbeat) {
    clearInterval(heartbeat);
    void startHeartbeat();
  }
},);
function startHeartbeat(): void {
  heartbeat = window.setInterval(async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: "lens.indicator.heartbeat" },);
      if (!result?.success) dismissStaticIndicator();
    }catch{
      dismissStaticIndicator();
    }
  }, heartbeatMs);
};
function createGlow(): HTMLDivElement {
  const element = document.createElement("div");
  element.id = indicatorIds.glow;
  Object.assign(element.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
    opacity: "0",
    transition: "opacity 0.3s ease-in-out",
    animation: "lens-pulse 2s ease-in-out infinite",
    boxShadow:
      "inset 0 0 10px rgba(59, 130, 246, 0.5), inset 0 0 20px rgba(59, 130, 246, 0.3), inset 0 0 30px rgba(59, 130, 246, 0.1)",
  },);
  return element;
};
function createStopControl(): HTMLDivElement {
  const container: HTMLDivElement = document.createElement("div");
  container.id = indicatorIds.stopContainer;
  Object.assign(container.style, {
    position: "fixed",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    pointerEvents: "none",
    zIndex: "2147483647",
  },);
  const button: HTMLButtonElement = document.createElement("button");
  button.id = indicatorIds.stopButton;
  button.innerHTML += `
    <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="margin-right: 12px; vertical-align: middle;">
      <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>${""}
    </svg>
    <span style="vertical-align: middle;">Stop Lens</span>
  ` + "";
  Object.assign(button.style, {
    position: "relative",
    transform: "translateY(100px)",
    padding: "12px 16px",
    background: "#FAF9F5",
    color: "#141413",
    border: "0.5px solid rgba(31, 30, 29, 0.4)",
    borderRadius: "12px",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 40px 80px rgba(59, 130, 246, 0.24), 0 4px 14px rgba(59, 130, 246, 0.24)",
    transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    opacity: "0",
    userSelect: "none",
    pointerEvents: "auto",
    whiteSpace: "nowrap",
    margin: "0 auto",
  },);
  button.addEventListener("mouseenter", function () {
    if (active) button.style.background = "#F5F4F0";
  },);
  button.addEventListener("mouseleave", function () {
    if (active) button.style.background = "#FAF9F5";
  },);
  button.addEventListener("click", async function () {
    await chrome.runtime.sendMessage({ type: "lens.agent.stop", fromTabId: "CURRENT_TAB" },);
  },);
  container.append(button);
  return container satisfies HTMLDivElement;
};
function createStaticNotice(): HTMLDivElement {
  const container: HTMLDivElement = document.createElement("div");
  container.id = indicatorIds.static;
  container.innerHTML += `
    <span style="width: 16px; height: 16px; margin-right: 8px; flex-shrink: 0; font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;">🔍</span>
    <span style="color: #141413; font-size: 14px;">Lens is active</span>
    <div style="width: 0.5px; height: 32px; background: rgba(31, 30, 29, 0.15); margin: 0 8px;"></div>${""}
    <button id="${indicatorIds.chatButton}" style="display: inline-flex; align-items: center; justify-content: center; padding: 6px; background: transparent; border: none; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; transition: background 0.2s;">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="#141413"><path d="M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5H3C2.79779 17.5 2.61549 17.3782 2.53809 17.1914C2.4607 17.0046 2.50349 16.7895 2.64648 16.6465L4.35547 14.9365C3.20124 13.6175 2.5 11.8906 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5Z"/></svg>
    </button>${""}
    <button id="${indicatorIds.closeButton}" style="display: inline-flex; align-items: center; justify-content: center; padding: 6px; background: transparent; border: none; cursor: pointer; width: 32px; height: 32px; margin-left: 4px; border-radius: 8px; transition: background 0.2s;">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15.1464 4.14642C15.3417 3.95121 15.6582 3.95118 15.8534 4.14642C16.0486 4.34168 16.0486 4.65822 15.8534 4.85346L10.7069 9.99997L15.8534 15.1465C16.0486 15.3417 16.0486 15.6583 15.8535 15.8535C15.6826 16.0244 15.4186 16.0461 15.2245 15.918L15.1464 15.8535L9.99989 10.707L4.85338 15.8535C4.65813 16.0486 4.34155 16.0486 4.14634 15.8535C3.95115 15.6583 3.95129 15.3418 4.14634 15.1465L9.29286 9.99997L4.14634 4.85346C3.95129 4.65818 3.95115 4.34162 4.14634 4.14642C4.34154 3.95128 4.65812 3.95138 4.85338 4.14642L9.99989 9.29294L15.1464 4.14642Z" fill="#141413"/></svg>
    </button>${""}
  ` + "";
  Object.assign(container.style, {
    position: "fixed",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 6px 6px 16px",
    background: "#FAF9F5",
    border: "0.5px solid rgba(31, 30, 29, 0.30)",
    borderRadius: "14px",
    boxShadow: "0 40px 80px 0 rgba(0, 0, 0, 0.15)",
    zIndex: "2147483647",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    userSelect: "none",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },);
  const chat = container.querySelector(`#${indicatorIds.chatButton}`) as HTMLButtonElement;
  const close = container.querySelector(`#${indicatorIds.closeButton}`) as HTMLButtonElement;
  for (const button of [chat, close] as HTMLButtonElement[]) {
    button.style.pointerEvents = "auto";
    button.addEventListener("mouseenter", function () { button.style.background = "#F0EEE6"; },);
    button.addEventListener("mouseleave", function () { button.style.background = "transparent"; },);
  }
  chat.addEventListener("click", async function () {
    await chrome.runtime.sendMessage({ type: "lens.open.openSidepanel" },);
  },);
  close.addEventListener("click", async function () {
    await chrome.runtime.sendMessage({ type: "lens.indicator.dismissStaticIndicator" },);
    dismissStaticIndicator();
  },);
  return container satisfies HTMLDivElement;
};
export function showIndicators(): void {
  if (active) return;
  active = true;
  injectIndicatorStyles();
  if (!glow) {
    glow = createGlow();
    document.body.appendChild(glow);
  }else{
    glow.style.display = "";
  }
  if (!stop) {
    stop = createStopControl();
    document.body.appendChild(stop);
  }else{
    stop.style.display = "";
  }
  requestAnimationFrame(function () {
    if (glow) glow.style.opacity = "1";
    const button = stop?.querySelector(`#${indicatorIds.stopButton}`) as HTMLElement | null;
    if (button) {
      button.style.transform = "translateY(0)";
      button.style.opacity = "1";
    }
  },);
};
export function hideIndicators(): void {
  if (!active) return;
  active = false;
  if (glow) glow.style.opacity = "0";
  const button = stop?.querySelector(`#${indicatorIds.stopButton}`) as HTMLElement | null;
  if (button) {
    button.style.transform = "translateY(100px)";
    button.style.opacity = "0";
  }
  setTimeout(function () {
    if (active) return;
    glow?.remove();
    stop?.remove();
    glow = null;
    stop = null;
  }, 300);
};
export function showStaticIndicator(): void {
  if (staticActive) return;
  staticActive = true;
  if (!staticNotice) {
    staticNotice = createStaticNotice();
    document.body.appendChild(staticNotice);
  }else{
    staticNotice.style.display = "";
  }
  if (heartbeat) clearInterval(heartbeat);
  void startHeartbeat();
};
export function dismissStaticIndicator(): void {
  if (!staticActive) return;
  staticActive = false;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  staticNotice?.remove();
  staticNotice = null;
};
export function hideForToolUse(): void {
  restoreActive = active;
  restoreStatic = staticActive;
  if (glow) glow.style.display = "none";
  if (stop) stop.style.display = "none";
  if (staticNotice && staticActive) staticNotice.style.display = "none";
};
export function showAfterToolUse(): void {
  if (restoreActive) {
    if (glow) glow.style.display = "";
    if (stop) stop.style.display = "";
  }
  if (restoreStatic && staticNotice) staticNotice.style.display = "";
  restoreActive = false;
  restoreStatic = false;
};
