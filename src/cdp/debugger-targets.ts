import { connectDebuggerEvents } from "./session-events";

type Debuggee = chrome.debugger.Debuggee;

export class DebuggerTargets {
	private readonly attached = new Map<number, Debuggee>();

	constructor(
		private readonly eventHandler: (
			tabId: number,
			method: string,
			params: any,
		) => void,
		private readonly attachHandler: (tabId: number) => void,
		private readonly detachHandler: (tabId: number, external?: boolean) => void,
	) {}

	async attach(tabId: number): Promise<void> {
		if (this.attached.has(tabId)) return;
		const target: Debuggee = { tabId };
		try {
			await chrome.debugger.attach(target, "1.3");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("Cannot access") ||
				message.includes("Cannot attach")
			) {
				throw new Error(
					"Cannot control this page. Chrome restricts automation on chrome://, extensions, and web store pages.",
				);
			}
			throw new Error(`Failed to attach debugger: ${message}`);
		}
		this.attached.set(tabId, target);
		this.connectEvents();
		this.attachHandler(tabId);
		try {
			await this.send(tabId, "Page.enable");
		} catch {}
	}

	async detach(tabId: number): Promise<void> {
		const target = this.attached.get(tabId);
		if (!target) return;
		try {
			await chrome.debugger.detach(target);
		} catch (error) {
			console.warn("[CDPController] Error detaching:", error);
		}
		this.attached.delete(tabId);
		this.detachHandler(tabId);
	}

	async detachAll(): Promise<void> {
		for (const tabId of this.attached.keys()) await this.detach(tabId);
	}

	async sendCommand(
		tabId: number,
		method: string,
		params?: object,
	): Promise<any> {
		await this.ensureAttached(tabId);
		return chrome.debugger.sendCommand(
			this.attached.get(tabId)!,
			method,
			params,
		);
	}

	async ensureAttached(tabId: number): Promise<void> {
		if (!this.attached.has(tabId)) await this.attach(tabId);
	}

	isAttached(tabId: number): boolean {
		return this.attached.has(tabId);
	}

	private send(tabId: number, method: string, params?: object): Promise<any> {
		return this.sendCommand(tabId, method, params);
	}

	private connectEvents(): void {
		connectDebuggerEvents(this.attached, this.eventHandler, (tabId) =>
			this.detachHandler(tabId, true),
		);
	}
}
