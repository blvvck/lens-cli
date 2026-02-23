export interface ConsoleMessage {
	type: string;
	text: string;
	timestamp: number;
	url?: string;
	line?: number;
}

export type NetworkRequest = {
	requestId: string;
	url: string;
	method: string;
	status?: number;
	type?: string;
	timestamp: number;
	requestHeaders?: Record<string, string>;
	requestBody?: string;
	responseHeaders?: Record<string, string>;
	responseBody?: string;
	mimeType?: string;
	duration?: number;
};

export interface NetworkEntry {
	id: string;
	ts: number;
	duration?: number;
	ttfb?: number;
	method: string;
	url: string;
	origin: string;
	requestHeaders: Record<string, string>;
	requestBody?: string;
	requestBodySize?: number;
	status?: number;
	statusText?: string;
	mimeType?: string;
	responseHeaders?: Record<string, string>;
	responseBody?: string;
	responseBodySize?: number;
	tabId: number;
	tabUrl?: string;
	type?: string;
	flags: string[];
	_requestId: string;
	_responseReceived: boolean;
	_loadingFinished: boolean;
}

export type PendingDialog = {
	type: "alert" | "confirm" | "prompt" | "beforeunload";
	message: string;
	defaultPrompt?: string;
	timestamp: number;
};
export type ConsoleEventCallback = (event: ConsoleMessage) => void;
export type NetworkEventCallback = (event: {
	method: string;
	url: string;
	status?: number;
	duration?: number;
	timestamp: number;
}) => void;
