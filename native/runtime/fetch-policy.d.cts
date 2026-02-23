export const MIME_TYPES: Readonly<Record<string, string>>;
export function getMimeType(filePath: string): string;
export function matchesUrlPattern(url: string, pattern: string): boolean;

declare const fetchPolicy: {
  MIME_TYPES: typeof MIME_TYPES;
  getMimeType: typeof getMimeType;
  matchesUrlPattern: typeof matchesUrlPattern;
};

export default fetchPolicy;
