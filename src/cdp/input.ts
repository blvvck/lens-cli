import { KeyboardInput } from "./input-keyboard";
import { PointerInput } from "./input-pointer";

export type MouseButton = "left" | "right" | "middle" | "none";

export class CDPInput {
	private readonly pointer: PointerInput;
	private readonly keyboard: KeyboardInput;

	constructor(
		send: (tabId: number, method: string, params?: object) => Promise<any>,
	) {
		this.pointer = new PointerInput(send);
		this.keyboard = new KeyboardInput(send);
	}

	click(
		tabId: number,
		x: number,
		y: number,
		button: MouseButton = "left",
		clickCount = 1,
		modifiers = 0,
	): Promise<void> {
		return this.pointer.click(tabId, x, y, button, clickCount, modifiers);
	}
	rightClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.pointer.click(tabId, x, y, "right", 1, modifiers);
	}
	doubleClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.pointer.click(tabId, x, y, "left", 2, modifiers);
	}
	tripleClick(
		tabId: number,
		x: number,
		y: number,
		modifiers = 0,
	): Promise<void> {
		return this.pointer.click(tabId, x, y, "left", 3, modifiers);
	}
	hover(tabId: number, x: number, y: number): Promise<void> {
		return this.pointer.hover(tabId, x, y);
	}
	drag(
		tabId: number,
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		modifiers = 0,
	): Promise<void> {
		return this.pointer.drag(tabId, startX, startY, endX, endY, modifiers);
	}
	scroll(
		tabId: number,
		x: number,
		y: number,
		deltaX: number,
		deltaY: number,
	): Promise<void> {
		return this.pointer.scroll(tabId, x, y, deltaX, deltaY);
	}
	type(tabId: number, text: string): Promise<void> {
		return this.keyboard.type(tabId, text);
	}
	pressKey(tabId: number, key: string, modifiers = 0): Promise<void> {
		return this.keyboard.pressKey(tabId, key, modifiers);
	}
	pressKeyChord(tabId: number, chord: string): Promise<void> {
		return this.keyboard.chord(tabId, chord);
	}
	parseModifiers(value?: string): number {
		return this.keyboard.parseModifiers(value);
	}
}
