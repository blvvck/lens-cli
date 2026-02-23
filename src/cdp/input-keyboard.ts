import { modifierBits, namedKeys, type KeyDefinition } from "./key-map";

function randomUnit(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
}

function delay(min: number, max: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, min + randomUnit() * (max - min)),
	);
}

export class KeyboardInput {
	constructor(
		private readonly send: (
			tabId: number,
			method: string,
			params?: object,
		) => Promise<any>,
	) {}

	async type(tabId: number, value: string): Promise<void> {
		for (const character of value) {
			if (character === "\n" || character === "\r")
				await this.pressKey(tabId, "Enter");
			else if (character === "\t") await this.pressKey(tabId, "Tab");
			else if (/^[a-zA-Z0-9]$/.test(character))
				await this.pressKey(tabId, character, /[A-Z]/.test(character) ? 8 : 0);
			else if (namedKeys[character] || namedKeys[character.toLowerCase()])
				await this.pressKey(tabId, character);
			else await this.send(tabId, "Input.insertText", { text: character });
			const pause =
				randomUnit() < 0.08 ? 300 + randomUnit() * 400 : 60 + randomUnit() * 40;
			await delay(pause * 0.8, pause * 1.2);
		}
	}

	async pressKey(tabId: number, key: string, modifiers = 0): Promise<void> {
		const definition = this.definition(key);
		if (!definition) throw new Error(`Unknown key: ${key}`);
		await this.dispatch(tabId, "keyDown", definition, modifiers);
		await this.dispatch(tabId, "keyUp", definition, modifiers);
	}

	async chord(tabId: number, value: string): Promise<void> {
		let modifiers = 0;
		let key = "";
		for (const part of value.toLowerCase().split("+")) {
			const bit = modifierBits.get(part);
			if (bit === undefined) key = part;
			else modifiers |= bit;
		}
		if (key) await this.pressKey(tabId, key, modifiers);
	}

	parseModifiers(value?: string): number {
		if (!value) return 0;
		return value
			.toLowerCase()
			.split("+")
			.reduce((mask, part) => mask | (modifierBits.get(part.trim()) ?? 0), 0);
	}

	private async dispatch(
		tabId: number,
		event: "keyDown" | "keyUp" | "rawKeyDown" | "char",
		key: KeyDefinition,
		modifiers: number,
	): Promise<void> {
		await this.send(tabId, "Input.dispatchKeyEvent", {
			type: key.text ? event : event === "keyDown" ? "rawKeyDown" : event,
			key: key.key,
			code: key.code,
			windowsVirtualKeyCode: key.keyCode,
			modifiers,
			text: key.text ?? "",
			unmodifiedText: key.text ?? "",
			location: key.location ?? 0,
		});
	}

	private definition(key: string): KeyDefinition | null {
		const named = namedKeys[key.toLowerCase()];
		if (named) return named;
		if (key.length !== 1) return null;
		const upper = key.toUpperCase();
		return {
			key,
			code: `Key${upper}`,
			keyCode: upper.charCodeAt(0),
			text: key,
		};
	}
}
