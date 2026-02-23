import { DebuggerTargets } from "./debugger-targets";

export class CDPSession {
	private readonly targets = new DebuggerTargets(
		(tabId, method, params) => this.onEvent(tabId, method, params),
		(tabId) => this.onAttach(tabId),
		(tabId, external) => this.onDetach(tabId, external),
	);
	onEvent: (tabId: number, method: string, params: any) => void = () => {};
	onAttach: (tabId: number) => void = () => {};
	onDetach: (tabId: number, external?: boolean) => void = () => {};

	attach(tabId: number): Promise<void> {
		return this.targets.attach(tabId);
	}
	detach(tabId: number): Promise<void> {
		return this.targets.detach(tabId);
	}
	detachAll(): Promise<void> {
		return this.targets.detachAll();
	}
	sendCommand(tabId: number, method: string, params?: object): Promise<any> {
		return this.targets.sendCommand(tabId, method, params);
	}
	ensureAttached(tabId: number): Promise<void> {
		return this.targets.ensureAttached(tabId);
	}
	isAttached(tabId: number): boolean {
		return this.targets.isAttached(tabId);
	}
}
