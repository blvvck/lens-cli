export type DeviceMode = {
  title: "default" | "spanned";
  orientation: "vertical" | "horizontal" | "vertical-spanned" | "horizontal-spanned";
  width?: number;
  height?: number;
  hinge?: { width: number; height: number; x: number; y: number };
};

export type DevicePreset = {
  width: number;
  height: number;
  screenWidth?: number;
  screenHeight?: number;
  screenOrientation?: {
    type: "portraitPrimary" | "landscapePrimary";
    angle: 0 | 90;
  };
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
  userAgentMetadata?: {
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
  };
  modes?: readonly DeviceMode[];
};

type CatalogEntry = DevicePreset & { name: string };

const ios = (platformVersion: string, model = "iPhone") => ({
  platform: "iOS",
  platformVersion,
  architecture: "",
  model,
  mobile: true,
});

const android = (platformVersion: string, model: string, mobile = true) => ({
  platform: "Android",
  platformVersion,
  architecture: "",
  model,
  mobile,
});

const modes = (foldable: boolean, verticalWidth: number, verticalHeight: number, horizontalWidth: number, horizontalHeight: number, verticalSpanned?: DeviceMode, horizontalSpanned?: DeviceMode): readonly DeviceMode[] => [
  { title: "default", orientation: "vertical", width: verticalWidth, height: verticalHeight },
  { title: "default", orientation: "horizontal", width: horizontalWidth, height: horizontalHeight },
  ...(foldable && verticalSpanned && horizontalSpanned ? [verticalSpanned, horizontalSpanned] : []),
];

const foldableModes = (
  verticalWidth: number,
  verticalHeight: number,
  horizontalWidth: number,
  horizontalHeight: number,
  verticalSpanned: DeviceMode,
  horizontalSpanned: DeviceMode,
) => modes(true, verticalWidth, verticalHeight, horizontalWidth, horizontalHeight, verticalSpanned, horizontalSpanned);

const catalog: readonly CatalogEntry[] = [
  { name: "iPhone SE", width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone XR", width: 414, height: 896, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 12 Pro", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 14", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 14 Plus", width: 428, height: 926, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 14 Pro", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 14 Pro Max", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 15", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 15 Plus", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 15 Pro", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 15 Pro Max", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 16e", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 16", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 16 Plus", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 16 Pro", width: 402, height: 874, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "iPhone 16 Pro Max", width: 440, height: 956, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5") },
  { name: "Pixel 7", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("13", "Pixel 7") },
  { name: "Pixel 8", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 8") },
  { name: "Pixel 8 Pro", width: 448, height: 997, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 8 Pro") },
  { name: "Pixel 8a", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 8a") },
  { name: "Pixel 9", width: 412, height: 924, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 9") },
  { name: "Pixel 9 Pro", width: 427, height: 952, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 9 Pro") },
  { name: "Pixel 9 Pro XL", width: 448, height: 997, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 9 Pro XL") },
  { name: "Pixel 10", width: 412, height: 924, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("16", "Pixel 10") },
  { name: "Samsung Galaxy S8+", width: 360, height: 740, deviceScaleFactor: 4, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("8.0.0", "SM-G955U") },
  { name: "Samsung Galaxy S20 Ultra", width: 412, height: 915, deviceScaleFactor: 3.5, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("13", "SM-G981B") },
  { name: "Surface Pro 7", width: 912, height: 1368, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36" },
  { name: "iPad Mini", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", userAgentMetadata: ios("18.5", "iPad") },
  { name: "iPad Pro 13", width: 1032, height: 1376, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", userAgentMetadata: ios("18.5", "iPad") },
  { name: "Surface Pro 10", width: 960, height: 1440, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36" },
  { name: "Surface Duo", width: 540, height: 720, deviceScaleFactor: 2.5, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 11.0; Surface Duo) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("11.0", "Surface Duo"), modes: foldableModes(540, 720, 720, 540, { title: "spanned", orientation: "vertical-spanned", width: 1114, height: 720, hinge: { width: 34, height: 720, x: 540, y: 0 } }, { title: "spanned", orientation: "horizontal-spanned", width: 720, height: 1114, hinge: { width: 720, height: 34, x: 0, y: 540 } }) },
  { name: "Samsung Galaxy A55", width: 360, height: 800, deviceScaleFactor: 2.25, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "SM-A556B") },
  { name: "Pixel 9 Pro Fold", width: 412, height: 922, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro Fold) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "Pixel 9 Pro Fold"), modes: foldableModes(412, 922, 922, 412, { title: "spanned", orientation: "vertical-spanned", width: 836, height: 842, hinge: { width: 0, height: 842, x: 418, y: 0 } }, { title: "spanned", orientation: "horizontal-spanned", width: 842, height: 836, hinge: { width: 842, height: 0, x: 0, y: 418 } }) },
  { name: "Galaxy Z Fold 6", width: 412, height: 968, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-F956U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("14", "SM-F956U"), modes: foldableModes(412, 968, 968, 412, { title: "spanned", orientation: "vertical-spanned", width: 744, height: 860, hinge: { width: 0, height: 860, x: 372, y: 0 } }, { title: "spanned", orientation: "horizontal-spanned", width: 860, height: 744, hinge: { width: 860, height: 0, x: 0, y: 372 } }) },
  { name: "Galaxy Z Fold 5", width: 344, height: 882, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("10.0", "SM-F946U"), modes: foldableModes(344, 882, 882, 344, { title: "spanned", orientation: "vertical-spanned", width: 690, height: 829, hinge: { width: 0, height: 829, x: 345, y: 0 } }, { title: "spanned", orientation: "horizontal-spanned", width: 829, height: 690, hinge: { width: 829, height: 0, x: 0, y: 345 } }) },
  { name: "Asus Zenbook Fold", width: 853, height: 1280, deviceScaleFactor: 1.5, mobile: false, touch: true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36", userAgentMetadata: { platform: "Windows", platformVersion: "11.0", architecture: "", model: "UX9702AA", mobile: false }, modes: foldableModes(853, 1280, 1280, 853, { title: "spanned", orientation: "vertical-spanned", width: 1706, height: 1280, hinge: { width: 107, height: 1280, x: 800, y: 0 } }, { title: "spanned", orientation: "horizontal-spanned", width: 1280, height: 1706, hinge: { width: 1706, height: 107, x: 0, y: 800 } }) },
  { name: "Samsung Galaxy A51/71", width: 412, height: 914, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("8.0.0", "SM-G955U") },
  { name: "Nest Hub Max", width: 1280, height: 800, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 CrKey/1.54.250320", modes: [{ title: "default", orientation: "horizontal", width: 1280, height: 800 }] },
  { name: "Galaxy Tab S4", width: 712, height: 1138, deviceScaleFactor: 2.25, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 8.1.0; SM-T837A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36", userAgentMetadata: android("8.1.0", "SM-T837A", false) },
  { name: "JioPhone 2", width: 240, height: 320, deviceScaleFactor: 1, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Mobile; LYF/F300B/LYF-F300B-001-01-15-130718-i;Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5", userAgentMetadata: android("", "LYF/F300B/LYF-F300B-001-01-15-130718-i") },
  { name: "Laptop with touch", width: 1280, height: 950, deviceScaleFactor: 1, mobile: false, touch: true, userAgent: "" },
  { name: "Laptop with HiDPI screen", width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, touch: false, userAgent: "" },
  { name: "Laptop with MDPI screen", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: "" },
  { name: "Moto G4", width: 360, height: 640, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 6.0.1; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("6.0.1", "Moto G (4)") },
  { name: "Moto G Power", width: 412, height: 823, deviceScaleFactor: 1.75, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36", userAgentMetadata: android("11", "moto g power (2022)") },
  { name: "Facebook on Android", width: 412, height: 892, deviceScaleFactor: 3.5, mobile: true, touch: true, userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SQ3A.220705.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/%s Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/407.0.0.0.65;]", userAgentMetadata: android("12", "Pixel 6") },
];

export const DEVICE_PRESETS: Readonly<Record<string, DevicePreset>> = Object.freeze(
  Object.fromEntries(catalog.map(({ name, ...preset }) => [
    name,
    {
      ...preset,
      screenWidth: preset.screenWidth ?? preset.width,
      screenHeight: preset.screenHeight ?? preset.height,
      screenOrientation: preset.screenOrientation ?? {
        type: preset.width > preset.height ? "landscapePrimary" : "portraitPrimary",
        angle: preset.width > preset.height ? 90 : 0,
      },
    },
  ])),
);

export const DEVICE_NAMES = catalog.map(({ name }) => name);
