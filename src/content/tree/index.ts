import { installPageBridge } from "./bridge";
import { registerAccessibilityHandlers } from "./handlers";

installPageBridge();
registerAccessibilityHandlers();

export { generateAccessibilityTree } from "./snapshot";
