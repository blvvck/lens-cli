import type { MouseButton } from "./input";

type Point = { x: number; y: number };
type MouseOptions = {
	button?: MouseButton;
	buttons?: number;
	clickCount?: number;
	modifiers?: number;
	deltaX?: number;
	deltaY?: number;
};

function pause(min: number, max: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, min + Math.random() * (max - min)),
	);
}

function pathBetween(start: Point, end: Point): Point[] {
	const bendX = (start.x + end.x) / 2 + (Math.random() - 0.5) * 60;
	const bendY = (start.y + end.y) / 2 + (Math.random() - 0.5) * 60;
	return Array.from({ length: 13 }, (_, step) => {
		const t = step / 12;
		const back = 1 - t;
		return {
			x: Math.round(
				back ** 2 * start.x + 2 * back * t * bendX + t ** 2 * end.x,
			),
			y: Math.round(
				back ** 2 * start.y + 2 * back * t * bendY + t ** 2 * end.y,
			),
		};
	});
}

export class PointerInput {
	private position: Point = { x: 640, y: 400 };

	constructor(
		private readonly send: (
			tabId: number,
			method: string,
			params?: object,
		) => Promise<any>,
	) {}

	async click(
		tabId: number,
		x: number,
		y: number,
		button: MouseButton,
		count: number,
		modifiers: number,
	): Promise<void> {
		const buttons =
			button === "left"
				? 1
				: button === "right"
					? 2
					: button === "middle"
						? 4
						: 0;
		for (const point of pathBetween(this.position, { x, y })) {
			await this.dispatch(tabId, "mouseMoved", point.x, point.y, { modifiers });
			await pause(8, 25);
		}
		this.position = { x, y };
		await pause(60, 180);
		for (let click = 1; click <= count; click++) {
			await this.dispatch(tabId, "mousePressed", x, y, {
				button,
				buttons,
				clickCount: click,
				modifiers,
			});
			await pause(40, 120);
			await this.dispatch(tabId, "mouseReleased", x, y, {
				button,
				clickCount: click,
				modifiers,
			});
			if (click < count) await pause(80, 150);
		}
	}

	hover(tabId: number, x: number, y: number): Promise<void> {
		return this.dispatch(tabId, "mouseMoved", x, y);
	}

	async drag(
		tabId: number,
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		modifiers: number,
	): Promise<void> {
		await this.dispatch(tabId, "mouseMoved", startX, startY);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await this.dispatch(tabId, "mousePressed", startX, startY, {
			button: "left",
			buttons: 1,
			clickCount: 1,
			modifiers,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		await this.dispatch(tabId, "mouseMoved", endX, endY, {
			button: "left",
			buttons: 1,
			modifiers,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		await this.dispatch(tabId, "mouseReleased", endX, endY, {
			button: "left",
			clickCount: 1,
			modifiers,
		});
	}

	scroll(
		tabId: number,
		x: number,
		y: number,
		deltaX: number,
		deltaY: number,
	): Promise<void> {
		return this.dispatch(tabId, "mouseWheel", x, y, { deltaX, deltaY });
	}

	private async dispatch(
		tabId: number,
		type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
		x: number,
		y: number,
		options: MouseOptions = {},
	): Promise<void> {
		const params: Record<string, any> = {
			type,
			x: Math.round(x),
			y: Math.round(y),
			modifiers: options.modifiers || 0,
		};
		if (type !== "mouseWheel") {
			params.button = options.button || "none";
			params.buttons = options.buttons ?? 0;
			if (type !== "mouseMoved") params.clickCount = options.clickCount || 1;
		} else {
			params.deltaX = options.deltaX || 0;
			params.deltaY = options.deltaY || 0;
		}
		await this.send(tabId, "Input.dispatchMouseEvent", params);
	}
}
