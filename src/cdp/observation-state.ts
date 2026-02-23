import type { ConsoleMessage, PendingDialog } from "./observe-types";

export type ConsoleOptions = {
	onlyErrors?: boolean;
	pattern?: string;
	limit?: number;
};

export class ConsoleState {
	private readonly records = new Map<number, ConsoleMessage[]>();

	open(tabId: number): void {
		this.records.set(tabId, []);
	}
	close(tabId: number): void {
		this.records.delete(tabId);
	}
	push(tabId: number, value: ConsoleMessage): void {
		const messages = this.records.get(tabId) ?? [];
		messages.push(value);
		if (messages.length > 1000) messages.shift();
		this.records.set(tabId, messages);
	}
	read(tabId: number): ConsoleMessage[] {
		return this.records.get(tabId) ?? [];
	}
	clear(tabId: number): void {
		this.records.set(tabId, []);
	}
	select(tabId: number, options?: ConsoleOptions): ConsoleMessage[] {
		let messages = this.read(tabId);
		if (options?.onlyErrors)
			messages = messages.filter(
				(message) => message.type === "error" || message.type === "exception",
			);
		if (options?.pattern) {
			try {
				const matcher = new RegExp(options.pattern, "i");
				messages = messages.filter((message) => matcher.test(message.text));
			} catch {
				messages = messages.filter((message) =>
					message.text.includes(options.pattern!),
				);
			}
		}
		if (options?.limit) messages = messages.slice(-options.limit);
		return [...messages];
	}
}

export class DialogState {
	private readonly active = new Map<number, PendingDialog>();
	put(tabId: number, dialog: PendingDialog): void {
		this.active.set(tabId, dialog);
	}
	get(tabId: number): PendingDialog | null {
		return this.active.get(tabId) ?? null;
	}
	clear(tabId: number): void {
		this.active.delete(tabId);
	}
}
