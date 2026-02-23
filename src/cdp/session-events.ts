type Debuggee = chrome.debugger.Debuggee;

let listenersConnected = false;

export function connectDebuggerEvents(
	targets: Map<number, Debuggee>,
	onEvent: (tabId: number, method: string, params: any) => void,
	onDetach: (tabId: number) => void,
): void {
	if (listenersConnected) return;
	listenersConnected = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (!tabId || !targets.has(tabId)) return;
		onEvent(tabId, method, params);
	});
	chrome.debugger.onDetach.addListener((source) => {
		const tabId = source.tabId;
		if (!tabId || !targets.has(tabId)) return;
		targets.delete(tabId);
		onDetach(tabId);
	});
}
