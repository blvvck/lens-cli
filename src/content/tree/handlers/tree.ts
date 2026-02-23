import { ACCESSIBILITY_MESSAGE_TYPES, normalizeAccessibilityTreeOptions } from "../accessibility-contract";
import { generateAccessibilityTree } from "../snapshot";
import { generateYamlTree, detectModalStates } from "../format";
import { validatePayload, requestHandler, type MessageHandler } from "./shared";

export const treeHandlers: Record<string, MessageHandler> = {
  [ACCESSIBILITY_MESSAGE_TYPES.GENERATE_TREE]: requestHandler((message, sendResponse) => {
    message = validatePayload(message, ['options']);
    const options = normalizeAccessibilityTreeOptions(message.options || {});

    if (options.format === "yaml") {
      const result = generateYamlTree(options.filter, options.depth);
      const modalStates = detectModalStates() || [];
      if (result.error) {
        sendResponse({ error: result.error, pageContent: "", viewport: result.viewport });
      } else {
        sendResponse({
          pageContent: result.yaml,
          viewport: result.viewport,
          modalStates: modalStates.length > 0 ? modalStates : undefined,
          modalLimitations:
            "Only custom modals ([role=dialog]) detected. Native alert/confirm/prompt dialogs and system file choosers cannot be detected from content scripts.",
        });
      }
    } else {
      const result = generateAccessibilityTree(
        options.filter,
        options.depth,
        options.refId,
        options.forceFullSnapshot ?? false,
        options.compact,
      );
      sendResponse(result);
    }
    return true;
  }),
};
