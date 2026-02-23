// action-policy.d.cts — Type declarations for action-policy.cjs

export interface ActionPolicyOptions {
  retries: number;
  backoffMs: number;
  timeout: number;
  waitFor: boolean;
  verify: boolean;
  verifySelector?: string;
  verifyText?: string;
  verifyTimeout: number;
  stabilityMs: number;
  jitterFactor: number;
  maxBackoffMs: number;
}

export interface PolicyDefaults {
  retries: number;
  backoffMs: number;
  timeout: number;
  waitFor: boolean;
  verify: boolean;
  verifyTimeout: number;
  stabilityMs: number;
  jitterFactor: number;
  maxBackoffMs: number;
}

export const DEFAULTS: Readonly<PolicyDefaults>;

export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  jitterFactor?: number,
  maxBackoffMs?: number
): number;

export function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    backoffMs?: number;
    timeout?: number;
    operationName?: string;
  }
): Promise<T>;

export interface PolicyRunner {
  execute<T>(params: {
    waitForReady?: () => Promise<boolean>;
    action: () => Promise<T>;
    verify?: () => Promise<boolean>;
    options?: Partial<ActionPolicyOptions>;
  }): Promise<{ success: true; result: T } | { success: false; error: string }>;

  retry<T>(
    fn: () => Promise<T>,
    options?: Partial<ActionPolicyOptions>
  ): Promise<T>;
}

export function createPolicyRunner(
  defaultOptions?: Partial<ActionPolicyOptions>
): PolicyRunner;

export function parsePolicyOptions(args: Record<string, unknown>): Pick<
  ActionPolicyOptions,
  'retries' | 'backoffMs' | 'timeout' | 'waitFor' | 'verify'
>;

export function parsePositiveInt(value: unknown, defaultValue: number): number;

export function isRetryableError(error: unknown): boolean;

export function sleep(ms: number): Promise<void>;
