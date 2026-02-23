import type {
	NetworkEntry,
	NetworkEventCallback,
	NetworkRequest,
} from "./observe";
import { RequestRegistry } from "./request-registry";
import { ResponseBodyFetcher } from "./response-bodies";

export const STATIC_ASSET_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/x-icon",
	"font/woff",
	"font/woff2",
	"font/ttf",
	"font/otf",
	"application/font-woff",
	"application/font-woff2",
	"text/css",
	"application/javascript",
	"text/javascript",
	"application/x-javascript",
]);

export const BINARY_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/x-icon",
	"font/woff",
	"font/woff2",
	"font/ttf",
	"font/otf",
	"application/font-woff",
	"application/font-woff2",
	"application/octet-stream",
	"application/pdf",
	"application/zip",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
	"video/mp4",
	"video/webm",
	"video/ogg",
]);

export class NetworkEvents {
	constructor(
		private readonly requests: RequestRegistry,
		private readonly bodies: ResponseBodyFetcher,
		private readonly listeners: Map<number, Map<number, NetworkEventCallback>>,
	) {}

	request(tabId: number, event: any): void {
		const request = event.request;
		if (!request) return;
		const id = event.requestId;
		const timestamp = event.timestamp ? event.timestamp * 1000 : Date.now();
		const headers = this.headerRecord(request.headers);
		const summary: NetworkRequest = {
			requestId: id,
			url: request.url,
			method: request.method,
			type: event.type,
			timestamp,
			requestHeaders: headers,
			requestBody: request.postData,
		};
		const detail: NetworkEntry = {
			id: this.requests.id(timestamp),
			ts: timestamp,
			method: request.method,
			url: request.url,
			origin: this.origin(request.url),
			requestHeaders: { ...headers },
			requestBody: request.postData,
			requestBodySize: request.postData ? request.postData.length : undefined,
			tabId,
			tabUrl: event.documentURL,
			type: event.type,
			flags: [],
			_requestId: id,
			_responseReceived: false,
			_loadingFinished: false,
		};
		this.requests.start(tabId, id, summary, detail);
		this.requests.begin(tabId, id, timestamp);
	}

	response(tabId: number, event: any): void {
		const response = event.response;
		if (!response) return;
		const id = event.requestId;
		const tracked = this.requests.markResponded(tabId, id);
		const summary = this.requests.summary(tabId, id);
		const headers = this.headerRecord(response.headers);
		if (summary) {
			summary.status = response.status;
			summary.mimeType = response.mimeType;
			if (response.headers) summary.responseHeaders = headers;
			const timestamp = Date.now();
			this.publish(tabId, {
				method: summary.method,
				url: summary.url,
				status: summary.status,
				duration: this.requests.elapsed(id, timestamp),
				timestamp,
			});
		}
		if (!tracked) return;
		const timestamp = event.timestamp ? event.timestamp * 1000 : Date.now();
		const detail = tracked.detail;
		detail.ttfb = this.requests.elapsed(id, timestamp);
		detail.status = response.status;
		detail.statusText = response.statusText;
		detail.mimeType = response.mimeType;
		detail.responseHeaders = headers;
		if (this.isBinary(response.mimeType)) detail.flags.push("binary");
		if (/protobuf|x-protobuf|application\/grpc/.test(response.mimeType ?? ""))
			detail.flags.push("protobuf");
		detail._responseReceived = true;
	}

	failed(tabId: number, event: any): void {
		const id = event.requestId;
		const summary = this.requests.summary(tabId, id);
		const tracked = this.requests.tracked(tabId, id);
		if (summary && !summary.status) {
			summary.status = 0;
			const timestamp = Date.now();
			this.publish(tabId, {
				method: summary.method,
				url: summary.url,
				status: 0,
				duration: this.requests.elapsed(id, timestamp),
				timestamp,
			});
		}
		if (!tracked) return;
		tracked.detail.duration = this.requests.elapsed(
			id,
			event.timestamp ? event.timestamp * 1000 : Date.now(),
		);
		tracked.detail.status = 0;
		tracked.detail.flags.push("failed");
		tracked.detail._loadingFinished = true;
		this.requests.finish(tabId, id);
	}

	async finished(tabId: number, event: any): Promise<void> {
		const id = event.requestId;
		const tracked = this.requests.tracked(tabId, id);
		const summary = this.requests.summary(tabId, id);
		const timestamp = event.timestamp ? event.timestamp * 1000 : Date.now();
		if (summary) summary.duration = this.requests.elapsed(id, timestamp);
		if (tracked) {
			tracked.detail.duration = this.requests.elapsed(id, timestamp);
			tracked.detail.responseBodySize = event.encodedDataLength;
			tracked.detail._loadingFinished = true;
		}
		if (tracked) this.requests.finish(tabId, id);
		if (!summary && !tracked) return;
		const mimeType = summary?.mimeType ?? tracked?.detail.mimeType;
		if (!this.bodies.shouldInline(mimeType, event.encodedDataLength)) return;
		const result = await this.bodies.get(tabId, id, "automatic");
		if (!result) return;
		if (summary) summary.responseBody = result.body;
		if (tracked) {
			tracked.detail.responseBody = result.body;
			if (result.invalidBase64) tracked.detail.flags.push("binary");
			if (result.truncated) tracked.detail.flags.push("truncated");
		}
	}

	origin(url: string): string {
		try {
			return new URL(url).origin;
		} catch {
			return "";
		}
	}

	isStatic(mimeType?: string): boolean {
		return Boolean(mimeType && STATIC_ASSET_TYPES.has(mimeType));
	}

	isBinary(mimeType?: string): boolean {
		return Boolean(mimeType && BINARY_TYPES.has(mimeType));
	}

	private headerRecord(
		headers?: Record<string, unknown>,
	): Record<string, string> {
		return Object.fromEntries(
			Object.entries(headers ?? {}).map(([key, value]) => [key, String(value)]),
		);
	}

	private publish(
		tabId: number,
		event: {
			method: string;
			url: string;
			status?: number;
			duration?: number;
			timestamp: number;
		},
	): void {
		this.listeners.get(tabId)?.forEach((callback) => callback(event));
	}
}
