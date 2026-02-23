type ReadFile = (path: string, encoding: string) => string;
type PathLike = {
  dirname(path: string): string;
  resolve(...paths: string[]): string;
};

export function buildInjectableAccessibilityScript(
  scriptSource: string,
  scriptPath: string,
  fsRef?: { readFileSync: ReadFile },
  pathRef?: PathLike,
): string;

export class HeadlessAccessibility {
  constructor(cdp: unknown);
  _injected: boolean;
  inject(): Promise<void>;
  getTree(options?: Record<string, unknown>): Promise<any>;
  getElementCoordinates(ref: string): Promise<any>;
  getElementFillInfo(ref: string): Promise<any>;
  setSelectValue(ref: string, value: string): Promise<any>;
  getPageText(): Promise<any>;
  getPageState(): Promise<any>;
}
