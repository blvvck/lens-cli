export type IncomingMessage = Record<string, any> & { type: string };
export type ResponseSender = (response: unknown) => void;
export type MessageHandler = (message: IncomingMessage, sendResponse: ResponseSender) => boolean | void;

export function validatePayload(message: IncomingMessage, fields: string[]): IncomingMessage {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    throw new TypeError("Invalid accessibility payload");
  }
  for (const field of fields) {
    const value = message[field];
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`Invalid accessibility payload field: ${field}`);
    }
  }
  return message;
}

export function replyBuilder(sender: ResponseSender): ResponseSender {
  return (value) => sender(value);
}

export function requestHandler(handler: MessageHandler): MessageHandler {
  return (message, sender) => handler(message, replyBuilder(sender));
}

export function errorResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function guarded(handler: MessageHandler, failure = errorResponse): MessageHandler {
  return (message, sender) => {
    try {
      return handler(message, sender);
    } catch (error) {
      sender(failure(error));
      return false;
    }
  };
}
