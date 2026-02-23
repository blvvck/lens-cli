export const indicatorIds = {
  glow: "lens-glow",
  stopContainer: "lens-stop-container",
  stopButton: "lens-stop-button",
  static: "lens-indicator",
  chatButton: "lens-chat-button",
  closeButton: "lens-close-button",
} as const;
const pulseColor = "59, 130, 246";
export function injectIndicatorStyles(): void {
  if (document.getElementById("lens-styles")) return;
  const style: HTMLStyleElement = document.createElement("style");
  style.id = "lens-styles";
  style.textContent = `
    @keyframes lens-pulse {
      0% { box-shadow: inset 0 0 10px rgba(${pulseColor}, 0.5), inset 0 0 20px rgba(${pulseColor}, 0.3), inset 0 0 30px rgba(${pulseColor}, 0.1); }
      50% { box-shadow: inset 0 0 15px rgba(${pulseColor}, 0.7), inset 0 0 25px rgba(${pulseColor}, 0.5), inset 0 0 35px rgba(${pulseColor}, 0.2); }
      100% { box-shadow: inset 0 0 10px rgba(${pulseColor}, 0.5), inset 0 0 20px rgba(${pulseColor}, 0.3), inset 0 0 30px rgba(${pulseColor}, 0.1); }
    }
  ` + "";
  document.head.append(style);
};
