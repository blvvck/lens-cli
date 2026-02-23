export interface SocketResolutionOptions {
  profile?: string | null;
  env?: Record<string, string | undefined>;
  platform?: string;
  exists?: (path: string) => boolean;
  readConfig?: () => { defaultProfile?: string } | null;
  currentProfile?: (platform?: string) => { endpoint?: string } | null;
  registeredProfiles?: (platform?: string) => Array<{ endpoint?: string }>;
  resolve?: (
    profile: string,
    platform?: string,
  ) => {
    profile: { slug?: string; endpoint?: string } | null;
    matches: Array<{ slug?: string }>;
    exact?: boolean;
  };
}

export interface SendToolOptions {
  socketPath?: string;
  timeout?: number;
  tabId?: number;
  windowId?: number;
  id?: string;
  rejectOnToolError?: boolean;
  connect?: (socketPath: string) => import("node:events").EventEmitter & {
    write: (chunk: string) => boolean;
    destroy: () => void;
  };
}

export declare const DEFAULT_TIMEOUT_MS: number;

export declare class LensClientError extends Error {
  code: string;
  [key: string]: unknown;
  constructor(message: string, code: string, extra?: Record<string, unknown>);
}

export declare function resolveSocketPath(options?: SocketResolutionOptions): string;

export declare function sendTool(
  tool: string,
  args?: Record<string, unknown>,
  options?: SendToolOptions,
): Promise<unknown>;

export declare function createClient(options?: SocketResolutionOptions & { socketPath?: string | null }): {
  socketPath: string | null;
  resolveSocketPath: (overrides?: SocketResolutionOptions) => string;
  sendTool: (tool: string, args?: Record<string, unknown>, overrides?: SendToolOptions) => Promise<unknown>;
};
