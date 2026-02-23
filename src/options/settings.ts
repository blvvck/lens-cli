const HEARTBEAT_MIN = 5;
const HEARTBEAT_MAX = 60;
const HEARTBEAT_FALLBACK = 10;
const app = document.getElementById("app");
if (app) {
  app.innerHTML = `
    <header>
      <h1>Lens settings</h1>
      <span class="muted">v${chrome.runtime.getManifest().version}</span>
    </header>
    <section>
      <label class="row">
        <input type="checkbox" id="debug-mode" />
        <span>Debug logging</span>
      </label>
      <p class="muted">Writes detailed messages to the extension console.</p>
    </section>
    <section>
      <label class="row">
        <span>Heartbeat interval</span>
        <input type="number" id="heartbeat-interval" min="${HEARTBEAT_MIN}" max="${HEARTBEAT_MAX}" />
        <span class="muted">seconds</span>
      </label>
      <p class="muted">How often the indicator checks whether Lens is still running (${HEARTBEAT_MIN} to ${HEARTBEAT_MAX}).</p>
    </section>
  `;
  bindDebugMode();
  bindHeartbeat();
};
function bindDebugMode(): void {
  const input = document.querySelector<HTMLInputElement>("#debug-mode");
  if (!input) return;
  void chrome.storage.local.get("debugMode").then(({ debugMode }) => {
    input.checked = Boolean(debugMode);
  },);
  input.addEventListener("change", () => {
    void chrome.storage.local.set({ debugMode: input.checked },);
  },);
};
function bindHeartbeat(): void {
  const input = document.querySelector<HTMLInputElement>("#heartbeat-interval");
  if (!input) return;
  void chrome.storage.local.get("heartbeatInterval").then((stored) => {
    input.value = String(clampHeartbeat(stored.heartbeatInterval));
  },);
  input.addEventListener("change", () => {
    input.value = String(clampHeartbeat(input.value));
    void chrome.storage.local.set({ heartbeatInterval: Number(input.value) },);
  },);
};
function clampHeartbeat(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return HEARTBEAT_FALLBACK;
  return Math.min(HEARTBEAT_MAX, Math.max(HEARTBEAT_MIN, parsed));
};
