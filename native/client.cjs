const fs = require("fs");
const net = require("net");

const {
  getBrowserEndpoint,
  getProfileEndpoint,
  getCurrentProfile,
  isWindows,
  listRegisteredProfiles,
  resolveProfile,
} = require("./runtime-paths.cjs");
const { loadConfig } = require("./config/index.cjs");

const DEFAULT_TIMEOUT_MS = 10000;

class LensClientError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "LensClientError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function resolveSocketPath(options = {}) {
  const {
    profile = null,
    env = process.env,
    platform = process.platform,
    exists = fs.existsSync,
    readConfig = loadConfig,
    currentProfile = getCurrentProfile,
    registeredProfiles = listRegisteredProfiles,
    resolve = resolveProfile,
  } = options;

  if (profile) {
    const resolved = resolve(profile, platform);
    if (resolved.profile) return resolved.profile.endpoint;
    if (resolved.matches.length > 1) {
      throw new LensClientError(
        `Ambiguous profile "${profile}". Matches: ${resolved.matches.map((entry) => entry.slug).join(", ")}`,
        "AMBIGUOUS_PROFILE",
        { matches: resolved.matches },
      );
    }
    const endpoint = getProfileEndpoint(profile, platform);
    if (!isWindows(platform) && exists(endpoint)) return endpoint;
    throw new LensClientError(
      `No socket found for profile "${profile}". Use: lens profile.list`,
      "PROFILE_NOT_FOUND",
      { profile },
    );
  }

  if (env.LENS_SOCKET) return env.LENS_SOCKET;

  const config = readConfig() || {};
  if (config.defaultProfile) {
    return resolveSocketPath({
      ...options,
      profile: config.defaultProfile,
    });
  }

  const current = currentProfile(platform);
  if (current?.endpoint) return current.endpoint;

  const profiles = registeredProfiles(platform);
  if (profiles.length === 1) return profiles[0].endpoint;

  return getBrowserEndpoint(platform);
}

function toolErrorMessage(response) {
  const content = response?.error?.content;
  if (Array.isArray(content)) {
    return content.map((entry) => entry?.text).filter(Boolean).join("\n") || "Tool call failed";
  }
  if (typeof response?.error === "string") return response.error;
  return "Tool call failed";
}

function sendTool(tool, args = {}, options = {}) {
  const {
    socketPath = resolveSocketPath(),
    timeout = DEFAULT_TIMEOUT_MS,
    tabId,
    windowId,
    id = `lens-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    rejectOnToolError = true,
    connect = net.createConnection,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let socket;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {}
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new LensClientError(`Timeout: ${tool} (${timeout}ms)`, "TIMEOUT", { tool, timeout }));
    }, timeout);

    try {
      socket = connect(socketPath);
    } catch (error) {
      finish(reject, new LensClientError(`Could not connect to ${socketPath}: ${error.message}`, "SOCKET_ERROR", { cause: error }));
      return;
    }

    socket.on("connect", () => {
      const request = {
        type: "lens.socket.toolRequest",
        method: "execute_tool",
        params: { tool, args },
        id,
      };
      if (tabId !== undefined) request.tabId = tabId;
      if (windowId !== undefined) request.windowId = windowId;
      try {
        socket.write(JSON.stringify(request) + "\n");
      } catch (error) {
        finish(reject, new LensClientError(`Could not send ${tool}: ${error.message}`, "SOCKET_ERROR", { cause: error }));
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        let response;
        try {
          response = JSON.parse(line);
        } catch {
          finish(reject, new LensClientError("Invalid JSON response from the Lens host", "INVALID_RESPONSE", { line }));
          return;
        }

        if (response.type === "lens.socket.extensionDisconnected") {
          finish(
            reject,
            new LensClientError(response.message || "The extension disconnected", "EXTENSION_DISCONNECTED", { response }),
          );
          return;
        }

        if (response.type !== "lens.socket.toolResponse") continue;

        if (rejectOnToolError && response.error) {
          finish(reject, new LensClientError(toolErrorMessage(response), "TOOL_ERROR", { response, tool }));
          return;
        }

        finish(resolve, response);
        return;
      }
    });

    socket.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(
          reject,
          new LensClientError("Lens not connected. Is Chrome running with the Lens extension?", "NOT_CONNECTED", { cause: error }),
        );
        return;
      }
      finish(reject, new LensClientError(error.message, "SOCKET_ERROR", { cause: error }));
    });

    socket.on("close", () => {
      finish(reject, new LensClientError("The Lens host closed the connection before responding", "CONNECTION_CLOSED", { tool }));
    });
  });
}

function createClient(options = {}) {
  const { socketPath = null } = options;
  return {
    socketPath,
    resolveSocketPath: (overrides = {}) => resolveSocketPath({ ...options, ...overrides }),
    sendTool: (tool, args = {}, overrides = {}) =>
      sendTool(tool, args, {
        ...(socketPath ? { socketPath } : {}),
        ...overrides,
      }),
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LensClientError,
  createClient,
  resolveSocketPath,
  sendTool,
};
