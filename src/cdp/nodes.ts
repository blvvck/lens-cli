import { CDPOperations, type OperationContext } from "./operations";

type Outcome = { success: boolean; error?: string };

export class CDPNodes {
	private readonly operations: CDPOperations;

	constructor(private readonly context: OperationContext) {
		this.operations = new CDPOperations(context);
	}

	async setFileInputBySelector(
		tabId: number,
		selector: string,
		files: string[],
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, "DOM.enable");
			const document = await this.context.send(tabId, "DOM.getDocument");
			const match = await this.context.send(tabId, "DOM.querySelector", {
				nodeId: document.root.nodeId,
				selector,
			});
			if (!match.nodeId)
				return { success: false, error: "Could not find element by selector" };
			await this.operations.run(tabId, "fileInput", {
				nodeId: match.nodeId,
				files,
			});
			return { success: true };
		} catch (error) {
			return this.error(error);
		}
	}

	async interceptFileChooser(
		tabId: number,
		files: string[],
		timeout = 10000,
	): Promise<Outcome> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, "Page.enable");
			await this.context.send(tabId, "DOM.enable");
			await this.context.send(tabId, "Page.setInterceptFileChooserDialog", {
				enabled: true,
			});
			return await new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.context
						.send(tabId, "Page.setInterceptFileChooserDialog", {
							enabled: false,
						})
						.catch(() => {});
					resolve({
						success: false,
						error: "File chooser dialog did not open within timeout",
					});
				}, timeout);
				const handler = async (
					source: chrome.debugger.Debuggee,
					method: string,
					params: any,
				) => {
					if (source.tabId !== tabId || method !== "Page.fileChooserOpened")
						return;
					chrome.debugger.onEvent.removeListener(handler);
					clearTimeout(timer);
					try {
						if (params.backendNodeId) {
							await this.operations.run(tabId, "fileInput", {
								backendNodeId: params.backendNodeId,
								files,
							});
						} else if (params.frameId) {
							const document = await this.context.send(
								tabId,
								"DOM.getDocument",
							);
							const match = await this.context.send(
								tabId,
								"DOM.querySelector",
								{
									nodeId: document.root.nodeId,
									selector: 'input[type="file"]',
								},
							);
							if (match.nodeId)
								await this.operations.run(tabId, "fileInput", {
									nodeId: match.nodeId,
									files,
								});
						}
						await this.context.send(
							tabId,
							"Page.setInterceptFileChooserDialog",
							{ enabled: false },
						);
						resolve({ success: true });
					} catch (error) {
						await this.context
							.send(tabId, "Page.setInterceptFileChooserDialog", {
								enabled: false,
							})
							.catch(() => {});
						resolve(this.error(error));
					}
				};
				chrome.debugger.onEvent.addListener(handler);
			});
		} catch (error) {
			return this.error(error);
		}
	}

	private error(error: unknown): Outcome {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
