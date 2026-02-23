import { RequestRegistry } from "./request-registry";
import { ResponseBodyFetcher } from "./response-bodies";
import {
	BINARY_TYPES as NETWORK_BINARY_TYPES,
	NetworkEvents,
	STATIC_ASSET_TYPES as NETWORK_STATIC_TYPES,
} from "./network-events";
import { NetworkQueries } from "./network-queries";
import {
	ConsoleState,
	DialogState,
	type ConsoleOptions,
} from "./observation-state";
import { StreamRegistry } from "./stream-registry";
import type {
	ConsoleEventCallback,
	ConsoleMessage,
	NetworkEntry,
	NetworkEventCallback,
	NetworkRequest,
	PendingDialog,
} from "./observe-types";
export type {
	ConsoleEventCallback,
	ConsoleMessage,
	NetworkEntry,
	NetworkEventCallback,
	NetworkRequest,
	PendingDialog,
} from "./observe-types";
export class CDPObserver {
	private consoleMessages = new ConsoleState();
	private requests = new RequestRegistry();
	private streams = new StreamRegistry();
	private pendingDialogs = new DialogState();
	private responseBodies: ResponseBodyFetcher;
	private networkEvents: NetworkEvents;
	private networkQueries: NetworkQueries;
	private fetchRequestHandler: ((tabId: number, params: any) => void) | null =
		null;
	private readonly eventAdapters: Record<
		string,
		(tabId: number, params: any) => void
	> = {
		"Runtime.consoleAPICalled": (tabId, params) =>
			this.handleRuntimeConsole(tabId, params),
		"Runtime.exceptionThrown": (tabId, params) =>
			this.handleRuntimeException(tabId, params),
		"Network.requestWillBeSent": (tabId, params) =>
			this.networkEvents.request(tabId, params),
		"Network.responseReceived": (tabId, params) =>
			this.networkEvents.response(tabId, params),
		"Network.loadingFailed": (tabId, params) =>
			this.networkEvents.failed(tabId, params),
		"Network.loadingFinished": (tabId, params) => {
			void this.networkEvents.finished(tabId, params);
		},
		"Page.javascriptDialogOpening": (tabId, params) =>
			this.handleDialogOpening(tabId, params),
		"Page.javascriptDialogClosed": (tabId) => this.pendingDialogs.clear(tabId),
		"Fetch.requestPaused": (tabId, params) =>
			this.fetchRequestHandler?.(tabId, params),
	};
	static readonly MAX_INLINE_BODY_SIZE = 16 * 1024;
	static readonly STATIC_ASSET_TYPES = NETWORK_STATIC_TYPES;
	static readonly BINARY_TYPES = NETWORK_BINARY_TYPES;
	constructor(
		private readonly send: (
			tabId: number,
			method: string,
			params?: object,
		) => Promise<any>,
		private readonly ensureAttached: (tabId: number) => Promise<void>,
	) {
		this.responseBodies = new ResponseBodyFetcher(
			send,
			(mimeType) => this.networkEvents.isStatic(mimeType),
			(mimeType) => this.networkEvents.isBinary(mimeType),
		);
		this.networkEvents = new NetworkEvents(
			this.requests,
			this.responseBodies,
			this.streams.network,
		);
		this.networkQueries = new NetworkQueries(this.requests, this.networkEvents);
	}
	onAttach(tabId: number): void {
		this.consoleMessages.open(tabId);
	}
	onDetach(tabId: number, external = false): void {
		this.consoleMessages.close(tabId);
		this.requests.close(tabId);
		this.streams.clear(tabId);
		if (!external) this.pendingDialogs.clear(tabId);
	}
	handleCDPEvent(tabId: number, method: string, params: any): void {
		this.eventAdapters[method]?.(tabId, params);
	}
	setFetchRequestHandler(handler: (tabId: number, params: any) => void): void {
		this.fetchRequestHandler = handler;
	}
	private handleRuntimeConsole(tabId: number, params: any): void {
		const msg = this.consoleRecord(params);
		this.consoleMessages.push(tabId, msg);
		this.streams.publish(this.streams.console.get(tabId), msg);
	}
	private handleRuntimeException(tabId: number, params: any): void {
		const details = params.exceptionDetails;
		if (!details) return;
		const msg = this.makeConsoleMessage(
			"exception",
			details.exception?.description || details.text || "Unknown exception",
			details.timestamp || Date.now(),
			details.url,
			details.lineNumber,
		);
		this.consoleMessages.push(tabId, msg);
		this.streams.publish(this.streams.console.get(tabId), msg);
	}
	private handleDialogOpening(tabId: number, params: any): void {
		this.pendingDialogs.put(tabId, {
			type: params.type,
			message: params.message,
			defaultPrompt: params.defaultPrompt,
			timestamp: Date.now(),
		});
	}
	private consoleRecord(params: any): ConsoleMessage {
		const frames = params.stackTrace?.callFrames ?? [];
		const text = (params.args ?? [])
			.map((argument: any) => {
				if (argument.value !== undefined) return String(argument.value);
				return argument.description || "";
			})
			.join(" ");
		return this.makeConsoleMessage(
			params.type || "log",
			text,
			params.timestamp || Date.now(),
			frames[0]?.url,
			frames[0]?.lineNumber,
		);
	}
	private makeConsoleMessage(
		type: string,
		text: string,
		timestamp: number,
		url?: string,
		line?: number,
	): ConsoleMessage {
		return { type, text, timestamp, url, line };
	}
	async enableConsoleTracking(tabId: number): Promise<void> {
		await this.ensureAttached(tabId);
		try {
			await this.send(tabId, "Runtime.enable");
		} catch (e) {}
	}
	async enableNetworkTracking(tabId: number): Promise<void> {
		await this.ensureAttached(tabId);
		try {
			await this.send(tabId, "Network.enable", { maxPostDataSize: 65536 });
		} catch (e) {}
	}
	async handleDialog(
		tabId: number,
		accept: boolean,
		promptText?: string,
	): Promise<{ success: boolean; error?: string }> {
		try {
			await this.send(tabId, "Page.handleJavaScriptDialog", {
				accept,
				promptText,
			});
			this.pendingDialogs.clear(tabId);
			return { success: true };
		} catch (e) {
			return {
				success: false,
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}
	getDialogInfo(tabId: number): PendingDialog | null {
		return this.pendingDialogs.get(tabId);
	}
	getConsoleMessages(
		tabId: number,
		options?: ConsoleOptions,
	): ConsoleMessage[] {
		return this.consoleMessages.select(tabId, options);
	}
	clearConsoleMessages(tabId: number): void {
		this.consoleMessages.clear(tabId);
	}
	getNetworkRequests(
		tabId: number,
		options?: { urlPattern?: string; limit?: number },
	): NetworkRequest[] {
		return this.networkQueries.requestsFor(tabId, options);
	}
	clearNetworkRequests(tabId: number): void {
		this.requests.clear(tabId);
	}
	getNetworkEntries(
		tabId: number,
		options?: { urlPattern?: string; limit?: number; includeStatic?: boolean },
	): NetworkEntry[] {
		return this.networkQueries.entriesFor(tabId, options);
	}
	getNetworkEntry(tabId: number, requestId: string): NetworkEntry | null {
		return this.networkQueries.entry(tabId, requestId);
	}
	findNetworkEntry(
		requestId: string,
		preferredTabId?: number,
	): NetworkEntry | null {
		return this.networkQueries.find(requestId, preferredTabId);
	}
	async getResponseBody(
		tabId: number,
		requestId: string,
	): Promise<{
		success: boolean;
		body?: string;
		base64Encoded?: boolean;
		error?: string;
	}> {
		await this.ensureAttached(tabId);
		return this.responseBodies.get(tabId, requestId, "explicit");
	}
	subscribeToConsole(
		tabId: number,
		streamId: number,
		callback: ConsoleEventCallback,
	): void {
		this.streams.subscribe(this.streams.console, tabId, streamId, callback);
	}
	unsubscribeFromConsole(tabId: number, streamId: number): void {
		this.streams.unsubscribe(this.streams.console, tabId, streamId);
	}
	subscribeToNetwork(
		tabId: number,
		streamId: number,
		callback: NetworkEventCallback,
	): void {
		this.streams.subscribe(this.streams.network, tabId, streamId, callback);
	}
	unsubscribeFromNetwork(tabId: number, streamId: number): void {
		this.streams.unsubscribe(this.streams.network, tabId, streamId);
	}
}
