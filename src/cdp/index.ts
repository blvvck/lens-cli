import { CDPCapture } from "./capture";
import { CDPInput, type MouseButton } from "./input";
import { CDPNodes } from "./nodes";
import {
	CDPObserver,
	type ConsoleEventCallback,
	type ConsoleMessage,
	type NetworkEntry,
	type NetworkEventCallback,
	type NetworkRequest,
	type PendingDialog,
} from "./observe";
import { CDPPage } from "./page";
import { CDPSession } from "./session";
import { CDPViewport } from "./viewport";

export class CDPController {
	private readonly session = new CDPSession();
	private readonly context = {
		send: (tabId: number, method: string, params?: object) =>
			this.session.sendCommand(tabId, method, params),
		ensureAttached: (tabId: number) => this.session.ensureAttached(tabId),
	};
	private readonly observer = new CDPObserver(
		this.context.send,
		this.context.ensureAttached,
	);
	private readonly input = new CDPInput(this.context.send);
	private readonly page = new CDPPage(this.context);
	private readonly capture = new CDPCapture(this.context);
	private readonly viewport = new CDPViewport(this.context);
	private readonly nodes = new CDPNodes(this.context);

	constructor() {
		this.session.onEvent = (tabId, method, params) =>
			this.observer.handleCDPEvent(tabId, method, params);
		this.session.onAttach = (tabId) => this.observer.onAttach(tabId);
		this.session.onDetach = (tabId, external) =>
			this.observer.onDetach(tabId, external);
	}

	setFetchRequestHandler(handler: (tabId: number, params: any) => void): void {
		this.observer.setFetchRequestHandler(handler);
	}
	enableConsoleTracking(tabId: number): Promise<void> {
		return this.observer.enableConsoleTracking(tabId);
	}
	enableNetworkTracking(tabId: number): Promise<void> {
		return this.observer.enableNetworkTracking(tabId);
	}
	handleDialog(
		tabId: number,
		accept: boolean,
		promptText?: string,
	): Promise<{ success: boolean; error?: string }> {
		return this.observer.handleDialog(tabId, accept, promptText);
	}
	getDialogInfo(tabId: number): PendingDialog | null {
		return this.observer.getDialogInfo(tabId);
	}
	getConsoleMessages(
		tabId: number,
		options?: { onlyErrors?: boolean; pattern?: string; limit?: number },
	): ConsoleMessage[] {
		return this.observer.getConsoleMessages(tabId, options);
	}
	clearConsoleMessages(tabId: number): void {
		this.observer.clearConsoleMessages(tabId);
	}
	getNetworkRequests(
		tabId: number,
		options?: { urlPattern?: string; limit?: number },
	): NetworkRequest[] {
		return this.observer.getNetworkRequests(tabId, options);
	}
	clearNetworkRequests(tabId: number): void {
		this.observer.clearNetworkRequests(tabId);
	}
	getNetworkEntries(
		tabId: number,
		options?: { urlPattern?: string; limit?: number; includeStatic?: boolean },
	): NetworkEntry[] {
		return this.observer.getNetworkEntries(tabId, options);
	}
	getNetworkEntry(tabId: number, requestId: string): NetworkEntry | null {
		return this.observer.getNetworkEntry(tabId, requestId);
	}
	findNetworkEntry(
		requestId: string,
		preferredTabId?: number,
	): NetworkEntry | null {
		return this.observer.findNetworkEntry(requestId, preferredTabId);
	}
	getResponseBody(
		tabId: number,
		requestId: string,
	): Promise<{
		success: boolean;
		body?: string;
		base64Encoded?: boolean;
		error?: string;
	}> {
		return this.observer.getResponseBody(tabId, requestId);
	}
	subscribeToConsole(
		tabId: number,
		streamId: number,
		callback: ConsoleEventCallback,
	): void {
		this.observer.subscribeToConsole(tabId, streamId, callback);
	}
	unsubscribeFromConsole(tabId: number, streamId: number): void {
		this.observer.unsubscribeFromConsole(tabId, streamId);
	}
	subscribeToNetwork(
		tabId: number,
		streamId: number,
		callback: NetworkEventCallback,
	): void {
		this.observer.subscribeToNetwork(tabId, streamId, callback);
	}
	unsubscribeFromNetwork(tabId: number, streamId: number): void {
		this.observer.unsubscribeFromNetwork(tabId, streamId);
	}

	click(
		tabId: number,
		x: number,
		y: number,
		button: MouseButton = "left",
		clickCount = 1,
		modifiers = 0,
	): Promise<void> {
		return this.input.click(tabId, x, y, button, clickCount, modifiers);
	}
	rightClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.input.rightClick(tabId, x, y, modifiers);
	}
	doubleClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.input.doubleClick(tabId, x, y, modifiers);
	}
	tripleClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.input.tripleClick(tabId, x, y, modifiers);
	}
	hover(tabId: number, x: number, y: number): Promise<void> {
		return this.input.hover(tabId, x, y);
	}
	drag(
		tabId: number,
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		modifiers = 0,
	): Promise<void> {
		return this.input.drag(tabId, startX, startY, endX, endY, modifiers);
	}
	scroll(
		tabId: number,
		x: number,
		y: number,
		deltaX: number,
		deltaY: number,
	): Promise<void> {
		return this.input.scroll(tabId, x, y, deltaX, deltaY);
	}
	type(tabId: number, text: string): Promise<void> {
		return this.input.type(tabId, text);
	}
	pressKey(tabId: number, key: string, modifiers = 0): Promise<void> {
		return this.input.pressKey(tabId, key, modifiers);
	}
	pressKeyChord(tabId: number, chord: string): Promise<void> {
		return this.input.pressKeyChord(tabId, chord);
	}
	parseModifiers(modifierString?: string): number {
		return this.input.parseModifiers(modifierString);
	}

	attach(tabId: number): Promise<void> {
		return this.session.attach(tabId);
	}
	detach(tabId: number): Promise<void> {
		return this.session.detach(tabId);
	}
	detachAll(): Promise<void> {
		return this.session.detachAll();
	}
	sendCommand(tabId: number, method: string, params?: object): Promise<any> {
		return this.session.sendCommand(tabId, method, params);
	}

	emulateNetwork(
		tabId: number,
		preset: string,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateNetwork(tabId, preset);
	}
	emulateCPU(
		tabId: number,
		rate: number,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateCPU(tabId, rate);
	}
	emulateGeolocation(
		tabId: number,
		latitude: number,
		longitude: number,
		accuracy?: number,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateGeolocation(
			tabId,
			latitude,
			longitude,
			accuracy,
		);
	}
	clearGeolocation(
		tabId: number,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.clearGeolocation(tabId);
	}
	emulateDevice(
		tabId: number,
		device: {
			width: number;
			height: number;
			screenWidth?: number;
			screenHeight?: number;
			deviceScaleFactor: number;
			mobile: boolean;
			screenOrientation?: {
				type: "portraitPrimary" | "landscapePrimary";
				angle: 0 | 90;
			};
			touch?: boolean;
			userAgent?: string;
			userAgentMetadata?: {
				platform: string;
				platformVersion: string;
				architecture: string;
				model: string;
				mobile: boolean;
			};
		},
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateDevice(tabId, device);
	}
	clearDeviceEmulation(
		tabId: number,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.clearDeviceEmulation(tabId);
	}
	emulateViewport(
		tabId: number,
		options: {
			width?: number;
			height?: number;
			deviceScaleFactor?: number;
			mobile?: boolean;
		},
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateViewport(tabId, options);
	}
	emulateTouch(
		tabId: number,
		enabled: boolean,
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.emulateTouch(tabId, enabled);
	}
	startPerformanceTrace(
		tabId: number,
		categories?: string[],
	): Promise<{ success: boolean; error?: string }> {
		return this.viewport.startPerformanceTrace(tabId, categories);
	}
	stopPerformanceTrace(
		tabId: number,
	): Promise<{ success: boolean; metrics?: any; error?: string }> {
		return this.viewport.stopPerformanceTrace(tabId);
	}
	getPerformanceMetrics(
		tabId: number,
	): Promise<{
		success: boolean;
		metrics?: Record<string, number>;
		error?: string;
	}> {
		return this.viewport.getPerformanceMetrics(tabId);
	}

	setFileInputBySelector(
		tabId: number,
		selector: string,
		files: string[],
	): Promise<{ success: boolean; error?: string }> {
		return this.nodes.setFileInputBySelector(tabId, selector, files);
	}
	interceptFileChooser(
		tabId: number,
		files: string[],
		timeout = 10000,
	): Promise<{ success: boolean; error?: string }> {
		return this.nodes.interceptFileChooser(tabId, files, timeout);
	}
	waitForLoad(
		tabId: number,
		timeout = 30000,
	): Promise<{ success: boolean; readyState?: string; error?: string }> {
		return this.page.waitForLoad(tabId, timeout);
	}
	getFrames(
		tabId: number,
	): Promise<{
		success: boolean;
		frames?: Array<{
			frameId: string;
			url: string;
			name: string;
			parentId?: string;
		}>;
		error?: string;
	}> {
		return this.page.getFrames(tabId);
	}
	evaluateInFrame(
		tabId: number,
		frameId: string,
		expression: string,
	): Promise<{ success: boolean; result?: any; error?: string }> {
		return this.page.evaluateInFrame(tabId, frameId, expression);
	}
	evaluateScript(tabId: number, expression: string): Promise<any> {
		return this.page.evaluateScript(tabId, expression);
	}
	getViewportSize(tabId: number): Promise<{ width: number; height: number }> {
		return this.viewport.size(tabId);
	}
	captureScreenshot(
		tabId: number,
	): Promise<{ base64: string; width: number; height: number }> {
		return this.capture.screenshot(tabId);
	}
	captureRegion(
		tabId: number,
		x: number,
		y: number,
		width: number,
		height: number,
	): Promise<{ base64: string; width: number; height: number }> {
		return this.capture.region(tabId, x, y, width, height);
	}
}

export type { NetworkEntry };
