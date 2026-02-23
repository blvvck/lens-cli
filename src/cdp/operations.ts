export type OperationContext = {
	send: (tabId: number, method: string, params?: object) => Promise<any>;
	ensureAttached: (tabId: number) => Promise<void>;
};

type Operation<Input, Output> = {
	method: string;
	parameters: (input: Input) => object | undefined;
	unwrap: (result: any, input: Input) => Output;
};

type OperationMap = {
	layoutMetrics: Operation<void, any>;
	screenshot: Operation<
		{ clip?: { x: number; y: number; width: number; height: number } },
		string
	>;
	runtimeEvaluation: Operation<
		{
			expression: string;
			contextId?: number;
			timeout?: number;
			omitAwaitPromise?: boolean;
		},
		any
	>;
	frameTree: Operation<void, any>;
	isolatedWorld: Operation<{ frameId: string }, number>;
	deviceMetrics: Operation<
		{
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
		},
		void
	>;
	geolocation: Operation<
		{ latitude: number; longitude: number; accuracy: number },
		void
	>;
	fileInput: Operation<
		{ nodeId?: number; backendNodeId?: number; files: string[] },
		void
	>;
};

const operations: OperationMap = {
	layoutMetrics: {
		method: "Page.getLayoutMetrics",
		parameters: () => undefined,
		unwrap: (result) => result,
	},
	screenshot: {
		method: "Page.captureScreenshot",
		parameters: (input) =>
			input.clip
				? { format: "png", clip: { ...input.clip, scale: 1 } }
				: { format: "png", captureBeyondViewport: false },
		unwrap: (result) => result.data,
	},
	runtimeEvaluation: {
		method: "Runtime.evaluate",
		parameters: (input) => ({
			expression: input.expression,
			...(input.contextId === undefined ? {} : { contextId: input.contextId }),
			returnByValue: true,
			...(input.omitAwaitPromise ? {} : { awaitPromise: true }),
			...(input.timeout === undefined ? {} : { timeout: input.timeout }),
		}),
		unwrap: (result) => result,
	},
	frameTree: {
		method: "Page.getFrameTree",
		parameters: () => undefined,
		unwrap: (result) => result.frameTree,
	},
	isolatedWorld: {
		method: "Page.createIsolatedWorld",
		parameters: (input) => ({
			frameId: input.frameId,
			worldName: "lens-isolated",
		}),
		unwrap: (result) => result.executionContextId,
	},
	deviceMetrics: {
		method: "Emulation.setDeviceMetricsOverride",
		parameters: (input) => input,
		unwrap: () => undefined,
	},
	geolocation: {
		method: "Emulation.setGeolocationOverride",
		parameters: (input) => input,
		unwrap: () => undefined,
	},
	fileInput: {
		method: "DOM.setFileInputFiles",
		parameters: (input) => input,
		unwrap: () => undefined,
	},
};

export class CDPOperations {
	constructor(private readonly context: OperationContext) {}

	async run<K extends keyof OperationMap>(
		tabId: number,
		name: K,
		input: Parameters<OperationMap[K]["parameters"]>[0],
	): Promise<ReturnType<OperationMap[K]["unwrap"]>> {
		await this.context.ensureAttached(tabId);
		const operation = operations[name] as Operation<any, any>;
		const result = await this.context.send(
			tabId,
			operation.method,
			operation.parameters(input),
		);
		return operation.unwrap(result, input);
	}
}
