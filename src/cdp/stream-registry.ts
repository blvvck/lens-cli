import type {
	ConsoleEventCallback,
	NetworkEventCallback,
} from "./observe-types";

export class StreamRegistry {
	readonly console = new Map<number, Map<number, ConsoleEventCallback>>();
	readonly network = new Map<number, Map<number, NetworkEventCallback>>();

	subscribe<T>(
		registry: Map<number, Map<number, T>>,
		tabId: number,
		streamId: number,
		callback: T,
	): void {
		const listeners = registry.get(tabId) ?? new Map<number, T>();
		listeners.set(streamId, callback);
		registry.set(tabId, listeners);
	}

	unsubscribe<T>(
		registry: Map<number, Map<number, T>>,
		tabId: number,
		streamId: number,
	): void {
		const listeners = registry.get(tabId);
		if (!listeners) return;
		listeners.delete(streamId);
		if (listeners.size === 0) registry.delete(tabId);
	}

	clear(tabId: number): void {
		this.console.delete(tabId);
		this.network.delete(tabId);
	}

	publish<T>(
		listeners: Map<number, (event: T) => void> | undefined,
		event: T,
	): void {
		listeners?.forEach((callback) => callback(event));
	}
}
