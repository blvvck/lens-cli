export type KeyDefinition = {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
	location?: number;
};

export const modifierBits = new Map<string, number>([
	["alt", 1],
	["ctrl", 2],
	["control", 2],
	["meta", 4],
	["cmd", 4],
	["command", 4],
	["win", 4],
	["windows", 4],
	["shift", 8],
]);

const specialKeys: Array<[string, string, number, string?]> = [
	["enter", "Enter", 13, "\r"],
	["tab", "Tab", 9],
	["escape", "Escape", 27],
	["backspace", "Backspace", 8],
	["delete", "Delete", 46],
	["arrowup", "ArrowUp", 38],
	["arrowdown", "ArrowDown", 40],
	["arrowleft", "ArrowLeft", 37],
	["arrowright", "ArrowRight", 39],
	["home", "Home", 36],
	["end", "End", 35],
	["pageup", "PageUp", 33],
	["pagedown", "PageDown", 34],
	["space", " ", 32, " "],
];

export const namedKeys: Record<string, KeyDefinition> = Object.fromEntries([
	...specialKeys.map(([name, key, keyCode, text]) => [
		name,
		{
			key,
			code: name === "space" ? "Space" : key,
			keyCode,
			...(text === undefined ? {} : { text }),
		},
	]),
	...Array.from({ length: 12 }, (_, index) => {
		const number = index + 1;
		const key = `F${number}`;
		return [`f${number}`, { key, code: key, keyCode: 111 + number }];
	}),
]);
