export type AutomaticBody = {
	body?: string;
	invalidBase64: boolean;
	truncated: boolean;
};
export type ExplicitBody = {
	success: boolean;
	body?: string;
	base64Encoded?: boolean;
	error?: string;
};

export class ResponseBodyFetcher {
	constructor(
		private readonly send: (
			tabId: number,
			method: string,
			params?: object,
		) => Promise<any>,
		private readonly isStatic: (mimeType?: string) => boolean,
		private readonly isBinary: (mimeType?: string) => boolean,
	) {}

	shouldInline(
		mimeType: string | undefined,
		size: number | undefined,
	): boolean {
		return (
			!this.isStatic(mimeType) &&
			!this.isBinary(mimeType) &&
			(size || 0) <= 16 * 1024
		);
	}

	async get(
		tabId: number,
		requestId: string,
		mode: "automatic",
	): Promise<AutomaticBody | undefined>;
	async get(
		tabId: number,
		requestId: string,
		mode: "explicit",
	): Promise<ExplicitBody>;
	async get(
		tabId: number,
		requestId: string,
		mode: "automatic" | "explicit",
	): Promise<AutomaticBody | ExplicitBody | undefined> {
		try {
			const result = await this.send(tabId, "Network.getResponseBody", {
				requestId,
			});
			if (mode === "explicit")
				return {
					success: true,
					body: result.body,
					base64Encoded: result.base64Encoded,
				};
			const decoded = result.base64Encoded
				? this.decode(result.body)
				: { body: result.body, invalid: false };
			let body = decoded.body;
			const truncated = Boolean(body && body.length > 16 * 1024);
			if (truncated) body = body.slice(0, 16 * 1024);
			return { body, invalidBase64: decoded.invalid, truncated };
		} catch (error) {
			if (mode === "automatic") return undefined;
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private decode(body: string): { body: string; invalid: boolean } {
		try {
			return { body: atob(body), invalid: false };
		} catch {
			return { body, invalid: true };
		}
	}
}
