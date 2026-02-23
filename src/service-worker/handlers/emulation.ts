import { cdp } from "../shared";
import type { ServiceWorkerHandlerMap } from "../shared";
import { DEVICE_NAMES, DEVICE_PRESETS, type DevicePreset } from "../emulated-devices";

export const emulationHandlers: ServiceWorkerHandlerMap = {
  "emulate.network": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.preset) throw new Error("No preset provided");
    const result = await cdp.emulateNetwork(tabId, message.preset);
    if (!result.success) throw new Error(result.error);
    return { success: true, preset: message.preset };
  },

  "emulate.cpu": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (message.rate === undefined) throw new Error("No rate provided");
    const result = await cdp.emulateCPU(tabId, message.rate);
    if (!result.success) throw new Error(result.error);
    return { success: true, rate: message.rate };
  },

  "emulate.geo": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (message.clear) {
      const result = await cdp.clearGeolocation(tabId);
      if (!result.success) throw new Error(result.error);
      return { success: true, cleared: true };
    }
    if (message.latitude === undefined || message.longitude === undefined) {
      throw new Error("Latitude and longitude required");
    }
    const result = await cdp.emulateGeolocation(tabId, message.latitude, message.longitude, message.accuracy);
    if (!result.success) throw new Error(result.error);
    return { success: true, latitude: message.latitude, longitude: message.longitude };
  },

  "emulate.deviceList": async () => ({
    devices: ["custom", ...DEVICE_NAMES],
  }),

  "emulate.device": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const deviceName = message.device || "custom";

    if (deviceName.toLowerCase() === "reset") {
      const result = await cdp.clearDeviceEmulation(tabId);
      if (!result.success) throw new Error(result.error);
      return { success: true, message: "Device emulation reset" };
    }

    let device: DevicePreset | undefined = Object.entries(DEVICE_PRESETS)
      .find(([name]) => name.toLowerCase() === deviceName.toLowerCase())?.[1];

    if (deviceName.toLowerCase() === "custom") {
      const width = Number(message.width);
      const height = Number(message.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("custom device requires positive --width and --height");
      }
      const deviceScaleFactor = Number(message.deviceScaleFactor ?? 1);
      if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
        throw new Error("custom device requires a positive --scale");
      }
      device = {
        width,
        height,
        deviceScaleFactor,
        mobile: Boolean(message.mobile),
        touch: Boolean(message.touch),
        userAgent: typeof message.userAgent === "string" ? message.userAgent : undefined,
      };
    }

    if (!device) {
      throw new Error(`Unknown device: ${deviceName}. Use --list to see available devices.`);
    }

    const result = await cdp.emulateDevice(tabId, device);
    if (!result.success) throw new Error(result.error);

    const foldable = device.modes?.some((mode) => mode.orientation.endsWith("-spanned"));
    return {
      success: true,
      device: deviceName,
      modes: device.modes,
      limitation: foldable
        ? "CDP applies the catalog's default vertical mode; Lens does not switch foldable hinge/posture modes."
        : undefined,
    };
  },

  "emulate.viewport": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    if (!message.width && !message.height) throw new Error("--width or --height required");
    const result = await cdp.emulateViewport(tabId, {
      width: message.width,
      height: message.height,
      deviceScaleFactor: message.deviceScaleFactor,
      mobile: message.mobile,
    });
    if (!result.success) throw new Error(result.error);
    return { success: true, width: message.width, height: message.height };
  },

  "emulate.touch": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const enabled = Boolean(message.enabled);
    const result = await cdp.emulateTouch(tabId, enabled);
    if (!result.success) throw new Error(result.error);
    return { success: true, enabled };
  },
};
