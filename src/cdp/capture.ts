import { CDPOperations, type OperationContext } from "./operations";

export class CDPCapture {
	private readonly operations: CDPOperations;

	constructor(private readonly context: OperationContext) {
		this.operations = new CDPOperations(context);
	}

	async screenshot(
		tabId: number,
	): Promise<{ base64: string; width: number; height: number }> {
		const base64 = await this.operations.run(tabId, "screenshot", {});
		const metrics = await this.operations.run(
			tabId,
			"layoutMetrics",
			undefined,
		);
		const viewport = metrics.visualViewport || metrics.layoutViewport;
		return {
			base64,
			width: Math.round(viewport.clientWidth),
			height: Math.round(viewport.clientHeight),
		};
	}

	async region(
		tabId: number,
		x: number,
		y: number,
		width: number,
		height: number,
	): Promise<{ base64: string; width: number; height: number }> {
		const base64 = await this.operations.run(tabId, "screenshot", {
			clip: { x, y, width, height },
		});
		return { base64, width, height };
	}
}
