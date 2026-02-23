import { CDPOperations, type OperationContext } from "./operations";

export type FrameView = {
	frameId: string;
	url: string;
	name: string;
	parentId?: string;
};

function flattenFrames(root: any): FrameView[] {
	const frames: FrameView[] = [];
	const visit = (node: any, parentId?: string): void => {
		const frame = node.frame;
		frames.push({
			frameId: frame.id,
			url: frame.url,
			name: frame.name || "",
			parentId,
		});
		node.childFrames?.forEach((child: any) => visit(child, frame.id));
	};
	visit(root);
	return frames;
}

export class CDPPage {
	private readonly operations: CDPOperations;

	constructor(private readonly context: OperationContext) {
		this.operations = new CDPOperations(context);
	}

	async waitForLoad(
		tabId: number,
		timeout = 30000,
	): Promise<{ success: boolean; readyState?: string; error?: string }> {
		await this.context.ensureAttached(tabId);
		try {
			const started = Date.now();
			while (Date.now() - started < timeout) {
				const state = await this.operations.run(tabId, "runtimeEvaluation", {
					expression: "document.readyState",
					omitAwaitPromise: true,
				});
				if (state.result?.value === "complete")
					return { success: true, readyState: "complete" };
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return {
				success: false,
				error: `Timeout waiting for page load (${timeout}ms)`,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async getFrames(
		tabId: number,
	): Promise<{ success: boolean; frames?: FrameView[]; error?: string }> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, "Page.enable");
			const tree = await this.operations.run(tabId, "frameTree", undefined);
			return { success: true, frames: flattenFrames(tree) };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async evaluateInFrame(
		tabId: number,
		frameId: string,
		expression: string,
	): Promise<{ success: boolean; result?: any; error?: string }> {
		await this.context.ensureAttached(tabId);
		try {
			const contextId = await this.operations.run(tabId, "isolatedWorld", {
				frameId,
			});
			const result = await this.operations.run(tabId, "runtimeEvaluation", {
				expression: `JSON.stringify((function() { ${expression} })())`,
				contextId,
			});
			if (result.exceptionDetails) {
				return {
					success: false,
					error:
						result.exceptionDetails.text ||
						result.exceptionDetails.exception?.description ||
						"Evaluation failed",
				};
			}
			const value = result.result?.value;
			try {
				return { success: true, result: JSON.parse(value) };
			} catch {
				return { success: true, result: value };
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async evaluateScript(tabId: number, expression: string): Promise<any> {
		await this.context.ensureAttached(tabId);
		try {
			await this.context.send(tabId, "Runtime.enable");
		} catch {}
		return this.operations.run(tabId, "runtimeEvaluation", {
			expression,
			timeout: 10000,
		});
	}
}
