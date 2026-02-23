import type { NetworkEntry, NetworkRequest } from "./observe";
import { NetworkEvents } from "./network-events";
import { RequestRegistry } from "./request-registry";

type RequestOptions = { urlPattern?: string; limit?: number };
type EntryOptions = RequestOptions & { includeStatic?: boolean };

export class NetworkQueries {
	constructor(
		private readonly requests: RequestRegistry,
		private readonly events: NetworkEvents,
	) {}

	requestsFor(tabId: number, options?: RequestOptions): NetworkRequest[] {
		let found = this.requests.historyFor(tabId);
		if (options?.urlPattern)
			found = found.filter((item) => item.url.includes(options.urlPattern!));
		if (options?.limit) found = found.slice(-options.limit);
		return [...found];
	}

	entriesFor(tabId: number, options?: EntryOptions): NetworkEntry[] {
		const records = this.requests.entries(tabId);
		let found =
			records && records.size > 0
				? Array.from(records.values())
				: this.requests.historyFor(tabId).map(
						(item, index) =>
							({
								id: `r_${item.timestamp}_${index}`,
								ts: item.timestamp,
								method: item.method,
								url: item.url,
								origin: this.events.origin(item.url),
								requestHeaders: {},
								tabId,
								type: item.type,
								status: item.status,
								flags: [],
								_requestId: item.requestId,
								_responseReceived: true,
								_loadingFinished: true,
							}) as NetworkEntry,
					);
		if (!options?.includeStatic)
			found = found.filter((entry) => !this.events.isStatic(entry.mimeType));
		if (options?.urlPattern)
			found = found.filter((entry) => entry.url.includes(options.urlPattern!));
		if (options?.limit) found = found.slice(-options.limit);
		return found;
	}

	entry(tabId: number, requestId: string): NetworkEntry | null {
		return this.requests.entries(tabId)?.get(requestId) || null;
	}

	find(requestId: string, preferredTabId?: number): NetworkEntry | null {
		const scan = (tabId: number): NetworkEntry | null => {
			const direct = this.entry(tabId, requestId);
			if (direct) return direct;
			return (
				this.entriesFor(tabId, { includeStatic: true }).find(
					(entry) => entry.id === requestId || entry._requestId === requestId,
				) || null
			);
		};
		if (preferredTabId !== undefined) {
			const selected = scan(preferredTabId);
			if (selected) return selected;
		}
		for (const tabId of this.requests.tabIds()) {
			if (tabId === preferredTabId) continue;
			const selected = scan(tabId);
			if (selected) return selected;
		}
		return null;
	}
}
