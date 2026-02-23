import { sendToNativeHost } from "./port";

export interface ApiStreamCallbacks {
  onStart: (status: number, headers: Record<string, string>) => void;
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

const streamCallbacks = new Map<string, ApiStreamCallbacks>();
let streamIdCounter = 0;

export function handleNativeApiResponse(msg: any): boolean {
  const { type, streamId } = msg;
  
  if (!streamId || !streamCallbacks.has(streamId)) {
    return false;
  }
  
  const callbacks = streamCallbacks.get(streamId)!;
  
  switch (type) {
    case "lens.nativeApi.responseStart":
      callbacks.onStart(msg.status, msg.headers);
      return true;
    case "lens.nativeApi.responseChunk":
      callbacks.onChunk(msg.chunk);
      return true;
    case "lens.nativeApi.responseEnd":
      callbacks.onEnd();
      streamCallbacks.delete(streamId);
      return true;
    case "lens.nativeApi.responseError":
      callbacks.onError(msg.error);
      streamCallbacks.delete(streamId);
      return true;
    default:
      return false;
  }
}

export async function nativeApiFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  callbacks: ApiStreamCallbacks
): Promise<void> {
  const streamId = `stream_${++streamIdCounter}_${Date.now()}`;
  
  streamCallbacks.set(streamId, callbacks);
  
  try {
    await sendToNativeHost({
      type: "lens.nativeApi.request",
      streamId,
      url,
      method: options.method || "POST",
      headers: options.headers || {},
      body: options.body,
    });
  } catch (err) {
    streamCallbacks.delete(streamId);
    callbacks.onError(err instanceof Error ? err.message : "Unknown error");
  }
}
