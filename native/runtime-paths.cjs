const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function getTmpDir() {
  return os.tmpdir();
}

function getRuntimeDir(platform = process.platform) {
  const override = process.env.LENS_RUNTIME_DIR;
  if (override) return override;
  return path.join(getTmpDir(), "lens");
}

function ensureRuntimeDir(platform = process.platform) {
  fs.mkdirSync(getRuntimeDir(platform), { recursive: true });
  fs.mkdirSync(getProfilesDir(platform), { recursive: true });
}

function getProfilesDir(platform = process.platform) {
  return path.join(getRuntimeDir(platform), "profiles");
}

function getCurrentProfilePath(platform = process.platform) {
  return path.join(getRuntimeDir(platform), "current-profile.json");
}

function getBrowserEndpoint(platform = process.platform) {
  return isWindows(platform) ? "\\\\.\\pipe\\lens.sock" : path.join(getTmpDir(), "lens.sock");
}

function getProfileEndpoint(slug, platform = process.platform) {
  const safeSlug = (slug || "anon").trim() || "anon";
  return isWindows(platform)
    ? `\\\\.\\pipe\\lens-${safeSlug}.sock`
    : path.join(getTmpDir(), `lens-${safeSlug}.sock`);
}

function getHeadlessEndpoint(platform = process.platform) {
  return isWindows(platform)
    ? "\\\\.\\pipe\\lens-headless.sock"
    : path.join(getTmpDir(), "lens-headless.sock");
}

function getHostLogPath(platform = process.platform) {
  return isWindows(platform)
    ? path.join(getRuntimeDir(platform), "lens-host.log")
    : path.join(getTmpDir(), "lens-host.log");
}

function getHeadlessLogPath(platform = process.platform) {
  return isWindows(platform)
    ? path.join(getRuntimeDir(platform), "lens-headless.log")
    : path.join(getTmpDir(), "lens-headless.log");
}

function getHeadlessPidPath(platform = process.platform) {
  return isWindows(platform)
    ? path.join(getRuntimeDir(platform), "lens-headless.pid")
    : path.join(getTmpDir(), "lens-headless.pid");
}

function getCdpEndpoint(platform = process.platform) {
  return isWindows(platform)
    ? "\\\\.\\pipe\\lens-cdp.sock"
    : path.join(getTmpDir(), "lens-cdp.sock");
}

function getCdpLogPath(platform = process.platform) {
  return isWindows(platform)
    ? path.join(getRuntimeDir(platform), "lens-cdp.log")
    : path.join(getTmpDir(), "lens-cdp.log");
}

function getCdpPidPath(platform = process.platform) {
  return isWindows(platform)
    ? path.join(getRuntimeDir(platform), "lens-cdp.pid")
    : path.join(getTmpDir(), "lens-cdp.pid");
}

function getNetworkBasePath() {
  return process.env.LENS_NETWORK_PATH || path.join(getTmpDir(), "lens");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function registerProfile({ slug, endpoint, email = null, pid = process.pid }, platform = process.platform) {
  ensureRuntimeDir(platform);
  const profile = {
    slug,
    endpoint,
    email,
    pid,
    updatedAt: Date.now(),
  };

  fs.writeFileSync(
    path.join(getProfilesDir(platform), `${slug}.json`),
    JSON.stringify(profile, null, 2),
  );
  fs.writeFileSync(getCurrentProfilePath(platform), JSON.stringify(profile, null, 2));
  return profile;
}

function unregisterProfile(slug, platform = process.platform) {
  try {
    fs.unlinkSync(path.join(getProfilesDir(platform), `${slug}.json`));
  } catch {}
}

function clearCurrentProfile(endpoint, platform = process.platform) {
  const current = readJson(getCurrentProfilePath(platform));
  if (!current) return;
  if (!endpoint || current.endpoint === endpoint) {
    try {
      fs.unlinkSync(getCurrentProfilePath(platform));
    } catch {}
  }
}

function listRegisteredProfiles(platform = process.platform) {
  const profilesDir = getProfilesDir(platform);
  if (!fs.existsSync(profilesDir)) return [];

  const profiles = [];
  for (const entry of fs.readdirSync(profilesDir)) {
    if (!entry.endsWith(".json")) continue;
    const profile = readJson(path.join(profilesDir, entry));
    if (!profile) continue;
    if (profile.pid && !isPidAlive(profile.pid)) {
      try {
        fs.unlinkSync(path.join(profilesDir, entry));
      } catch {}
      continue;
    }
    profiles.push(profile);
  }

  profiles.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return profiles;
}

function getCurrentProfile(platform = process.platform) {
  const current = readJson(getCurrentProfilePath(platform));
  if (!current) return null;
  if (current.pid && !isPidAlive(current.pid)) {
    clearCurrentProfile(current.endpoint, platform);
    return null;
  }
  return current;
}

function resolveProfile(profileArg, platform = process.platform) {
  const profiles = listRegisteredProfiles(platform);
  const exact = profiles.find((profile) => profile.slug === profileArg);
  if (exact) {
    return { profile: exact, matches: [exact], exact: true };
  }

  const matches = profiles.filter((profile) => profile.slug.includes(profileArg));
  if (matches.length === 1) {
    return { profile: matches[0], matches, exact: false };
  }

  return { profile: null, matches, exact: false };
}

function resolveBrowserEndpoint(profileArg, platform = process.platform) {
  if (profileArg) {
    const resolved = resolveProfile(profileArg, platform);
    if (resolved.profile) return resolved.profile.endpoint;
    if (!isWindows(platform)) return getProfileEndpoint(profileArg, platform);
    return null;
  }

  const current = getCurrentProfile(platform);
  if (current?.endpoint) return current.endpoint;
  const profiles = listRegisteredProfiles(platform);
  if (profiles.length === 1) return profiles[0].endpoint;
  return getBrowserEndpoint(platform);
}

function cleanupEndpoint(endpoint, platform = process.platform) {
  if (isWindows(platform) || !endpoint) return;
  try {
    fs.unlinkSync(endpoint);
  } catch {}
}

function lookupOnPath(commands, platform = process.platform) {
  const binary = isWindows(platform) ? "where.exe" : "which";
  for (const command of commands) {
    try {
      const result = execFileSync(binary, [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!result) continue;
      return result.split(/\r?\n/)[0].trim();
    } catch {}
  }
  return null;
}

function findChromiumBinary({
  platform = process.platform,
  env = process.env,
  configPath = null,
  exists = fs.existsSync,
  lookupOnPath: customLookupOnPath = lookupOnPath,
} = {}) {
  const envCandidates = [env.CHROMIUM_PATH, env.CHROME_PATH, configPath].filter(Boolean);
  for (const candidate of envCandidates) {
    if (exists(candidate)) return candidate;
  }

  let candidates;
  if (platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  } else if (platform === "win32") {
    const join = path.win32.join;
    const localAppData = env.LOCALAPPDATA || "C:\\Users\\HP\\AppData\\Local";
    const programFiles = env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    candidates = [
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join(programFiles, "Chromium", "Application", "chrome.exe"),
      join(programFilesX86, "Chromium", "Application", "chrome.exe"),
      join(localAppData, "Chromium", "Application", "chrome.exe"),
    ];
  } else {
    candidates = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
    ];
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const pathCommands =
    platform === "win32"
      ? ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
  return customLookupOnPath(pathCommands, platform);
}

module.exports = {
  cleanupEndpoint,
  clearCurrentProfile,
  ensureRuntimeDir,
  findChromiumBinary,
  getBrowserEndpoint,
  getCdpEndpoint,
  getCdpLogPath,
  getCdpPidPath,
  getCurrentProfile,
  getCurrentProfilePath,
  getHeadlessEndpoint,
  getHeadlessLogPath,
  getHeadlessPidPath,
  getHostLogPath,
  getNetworkBasePath,
  getProfileEndpoint,
  getProfilesDir,
  getRuntimeDir,
  getTmpDir,
  isPidAlive,
  isWindows,
  listRegisteredProfiles,
  lookupOnPath,
  registerProfile,
  resolveBrowserEndpoint,
  resolveProfile,
  unregisterProfile,
};
