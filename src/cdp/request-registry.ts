import type { NetworkEntry, NetworkRequest } from "./observe";

type RequestState = "started" | "responded" | "finished";

export type TrackedRequest = {
	summary: NetworkRequest;
	detail: NetworkEntry;
	state: RequestState;
};

export class RequestRegistry {
	private readonly byTab = new Map<number, Map<string, TrackedRequest>>();
	private readonly history = new Map<number, NetworkRequest[]>();
	private readonly startedAt = new Map<string, number>();
	private sequence = 0;

	begin(
		tabId: number,
		requestId: string,
		timestamp: number,
	): TrackedRequest | undefined {
		this.startedAt.set(requestId, timestamp);
		return this.byTab.get(tabId)?.get(requestId);
	}

	start(
		tabId: number,
		requestId: string,
		summary: NetworkRequest,
		detail: NetworkEntry,
	): void {
		const tracked = this.byTab.get(tabId) ?? new Map<string, TrackedRequest>();
		const requests = this.history.get(tabId) ?? [];
		requests.push(summary);
		if (requests.length > 500) requests.shift();
		this.history.set(tabId, requests);
		if (tracked.size > 500) {
			const firstId = tracked.keys().next().value;
			if (firstId) tracked.delete(firstId);
		}
		tracked.set(requestId, { summary, detail, state: "started" });
		this.byTab.set(tabId, tracked);
	}

	summary(tabId: number, requestId: string): NetworkRequest | undefined {
		return this.history
			.get(tabId)
			?.find((request) => request.requestId === requestId);
	}

	tracked(tabId: number, requestId: string): TrackedRequest | undefined {
		return this.byTab.get(tabId)?.get(requestId);
	}

	markResponded(tabId: number, requestId: string): TrackedRequest | undefined {
		const current = this.tracked(tabId, requestId);
		if (current) current.state = "responded";
		return current;
	}

	entries(tabId: number): Map<string, NetworkEntry> | undefined {
		const requests = this.byTab.get(tabId);
		return (
			requests &&
			new Map([...requests].map(([id, request]) => [id, request.detail]))
		);
	}

	historyFor(tabId: number): NetworkRequest[] {
		return this.history.get(tabId) ?? [];
	}

	elapsed(requestId: string, finishTime?: number): number | undefined {
		const start = this.startedAt.get(requestId);
		return start === undefined || finishTime === undefined
			? undefined
			: Math.round(finishTime - start);
	}

	id(timestamp: number): string {
		this.sequence += 1;
		return `r_${timestamp}_${this.sequence}`;
	}

	finish(tabId: number, requestId: string): void {
		const current = this.tracked(tabId, requestId);
		if (current) current.state = "finished";
		this.startedAt.delete(requestId);
	}

	close(tabId: number): void {
		this.byTab.delete(tabId);
		this.history.delete(tabId);
	}

	clear(tabId: number): void {
		this.history.set(tabId, []);
		this.byTab.set(tabId, new Map());
	}

	tabIds(): Set<number> {
		return new Set([...this.byTab.keys(), ...this.history.keys()]);
	}
}
