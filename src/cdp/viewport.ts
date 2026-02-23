import { CDPOperations, type OperationContext } from "./operations";

type Outcome = { success: boolean; error?: string };

const networkProfiles: Record<
	string,
	{
		offline: boolean;
		latency: number;
		downloadThroughput: number;
		uploadThroughput: number;
	}
> = {
	offline: {
		offline: true,
		latency: 0,
		downloadThroughput: 0,
		uploadThroughput: 0,
	},
	"slow-3g": {
		offline: false,
		latency: 2000,
		downloadThroughput: 50000,
		uploadThroughput: 50000,
	},
	"fast-3g": {
		offline: false,
		latency: 562.5,
		downloadThroughput: 180000,
		uploadThroughput: 84375,
	},
	"4g": {
		offline: false,
		latency: 100,
		downloadThroughput: 4000000,
		uploadThroughput: 3000000,
	},
	reset: {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	},
};

export class CDPViewport {
	private readonly operations: CDPOperations;

	constructor(private readonly context: OperationContext) {
		this.operations = new CDPOperations(context);
	}

	async size(tabId: number): Promise<{ width: number; height: number }> {
		const metrics = await this.operations.run(
			tabId,
			"layoutMetrics",
			undefined,
		);
		const viewport = metrics.visualViewport || metrics.layoutViewport;
		return {
			width: Math.round(viewport.clientWidth),
			height: Math.round(viewport.clientHeight),
		};
	}

	async emulateNetwork(tabId: number, preset: string): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		const config = networkProfiles[preset.toLowerCase().replace(/\s+/g, "-")];
		if (!config)
			return {
				success: false,
				error: `Unknown preset: ${preset}. Available: ${Object.keys(networkProfiles).join(", ")}`,
			};
		return this.sequence(tabId, [
			["Network.enable"],
			["Network.emulateNetworkConditions", config],
		]);
	}

	async emulateCPU(tabId: number, rate: number): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		if (rate < 1)
			return {
				success: false,
				error:
					"CPU throttling rate must be >= 1 (1 = no throttle, 4 = 4x slower)",
			};
		return this.sequence(tabId, [["Emulation.setCPUThrottlingRate", { rate }]]);
	}

	async emulateGeolocation(
		tabId: number,
		latitude: number,
		longitude: number,
		accuracy?: number,
	): Promise<Outcome> {
		return this.result(tabId, "Emulation.setGeolocationOverride", {
			latitude,
			longitude,
			accuracy: accuracy || 100,
		});
	}

	async clearGeolocation(tabId: number): Promise<Outcome> {
		return this.result(tabId, "Emulation.clearGeolocationOverride");
	}

	async emulateDevice(
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
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			await this.operations.run(tabId, "deviceMetrics", {
				width: device.width,
				height: device.height,
				...(device.screenWidth === undefined ? {} : { screenWidth: device.screenWidth }),
				...(device.screenHeight === undefined ? {} : { screenHeight: device.screenHeight }),
				deviceScaleFactor: device.deviceScaleFactor,
				mobile: device.mobile,
				...(device.screenOrientation === undefined ? {} : { screenOrientation: device.screenOrientation }),
			});
			const userAgent = await this.resolveUserAgent(tabId, device.userAgent ?? "");
			await this.context.send(tabId, "Emulation.setUserAgentOverride", {
				userAgent,
				...(device.userAgentMetadata === undefined ? {} : { userAgentMetadata: device.userAgentMetadata }),
			});
			await this.context.send(tabId, "Emulation.setTouchEmulationEnabled", {
				enabled: Boolean(device.touch),
				maxTouchPoints: device.touch ? 5 : 0,
			});
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	private async resolveUserAgent(tabId: number, userAgent: string): Promise<string> {
		if (!userAgent.includes("%s")) return userAgent;
		await this.context.send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
		const current = await this.context.send(tabId, "Runtime.evaluate", {
			expression: "navigator.userAgent",
			returnByValue: true,
		});
		const currentUserAgent = current?.result?.result?.value || "";
		const version = currentUserAgent.match(/(?:HeadlessChrome|Chrome|Chromium)\/([\d.]+)/)?.[1];
		if (!version) {
			throw new Error("Could not determine the active Chromium version for this device preset");
		}
		return userAgent.replaceAll("%s", version);
	}

	async clearDeviceEmulation(tabId: number): Promise<Outcome> {
		return this.runSequence(tabId, [
			["Emulation.clearDeviceMetricsOverride"],
			["Emulation.setUserAgentOverride", { userAgent: "" }],
			["Emulation.setTouchEmulationEnabled", { enabled: false }],
		]);
	}

	async emulateViewport(
		tabId: number,
		options: {
			width?: number;
			height?: number;
			deviceScaleFactor?: number;
			mobile?: boolean;
		},
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			const viewport = await this.size(tabId);
			await this.operations.run(tabId, "deviceMetrics", {
				width: options.width || viewport.width,
				height: options.height || viewport.height,
				deviceScaleFactor: options.deviceScaleFactor || 1,
				mobile: options.mobile || false,
			});
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	async emulateTouch(tabId: number, enabled: boolean): Promise<Outcome> {
		return this.result(tabId, "Emulation.setTouchEmulationEnabled", {
			enabled,
			maxTouchPoints: enabled ? 5 : 0,
		});
	}

	async startPerformanceTrace(
		tabId: number,
		categories?: string[],
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, "Performance.enable");
			await this.context.send(tabId, "Tracing.start", {
				categories:
					categories?.join(",") ||
					"devtools.timeline,v8.execute,disabled-by-default-devtools.timeline",
				transferMode: "ReturnAsStream",
			});
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	async stopPerformanceTrace(
		tabId: number,
	): Promise<{ success: boolean; metrics?: any; error?: string }> {
		await this.context.ensureAttached(tabId);
		try {
			const metrics = await this.samples(tabId);
			await this.context.send(tabId, "Tracing.end");
			await this.context.send(tabId, "Performance.disable");
			return { success: true, metrics };
		} catch (error) {
			return this.error(error);
		}
	}

	async getPerformanceMetrics(
		tabId: number,
	): Promise<{
		success: boolean;
		metrics?: Record<string, number>;
		error?: string;
	}> {
		await this.context.ensureAttached(tabId);
		try {
			const metrics = await this.samples(tabId);
			await this.context.send(tabId, "Performance.disable");
			return { success: true, metrics };
		} catch (error) {
			return this.error(error);
		}
	}

	private async samples(tabId: number): Promise<Record<string, number>> {
		await this.context.send(tabId, "Performance.enable");
		const result = await this.context.send(tabId, "Performance.getMetrics");
		const metrics: Record<string, number> = {};
		for (const sample of result.metrics || [])
			metrics[sample.name] = sample.value;
		return metrics;
	}

	private async result(
		tabId: number,
		method: string,
		params?: object,
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, method, params);
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	private async runSequence(
		tabId: number,
		commands: Array<[string, object?]>,
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		return this.sequence(tabId, commands);
	}

	private async sequence(
		tabId: number,
		commands: Array<[string, object?]>,
	): Promise<Outcome> {
		try {
			for (const [method, params] of commands)
				await this.context.send(tabId, method, params);
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	private error(
		error: unknown,
	): Outcome & { metrics?: Record<string, number> } {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
