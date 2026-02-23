#!/usr/bin/env node
const filesystem = require('fs')
const paths = require('path')
const system = require('os')
const { execSync } = require('child_process')
const HOST_NAME = 'lens.browser.host'
const browserRows = [
	['chrome', 'Google Chrome', ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'], ['.config', 'google-chrome', 'NativeMessagingHosts'], ['Google', 'Chrome']],
	['chromium', 'Chromium', ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'], ['.config', 'chromium', 'NativeMessagingHosts'], ['Chromium']],
	['brave', 'Brave', ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'], ['.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'], ['BraveSoftware', 'Brave-Browser']],
	['edge', 'Microsoft Edge', ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'], ['.config', 'microsoft-edge', 'NativeMessagingHosts'], ['Microsoft', 'Edge']],
	['arc', 'Arc', ['Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'], null, null],
]
const BROWSERS = new Map(browserRows.map(([key, name, mac, linux, windows]) => [
	key,
	[name, mac?.join('/'), linux?.join('/'), windows?.join('\\') ?? null],
]))
const wrapperDirectory = () => ({
	darwin: paths.join(system.homedir(), 'Library/Application Support/lens-cli'),
	linux: paths.join(system.homedir(), '.local/share/lens-cli'),
	win32: paths.join(process.env.LOCALAPPDATA || paths.join(system.homedir(), 'AppData/Local'), 'lens-cli'),
})[process.platform] ?? null
function deleteWindowsRegistration(browser) {
	const key = `HKCU\\Software\\${BROWSERS.get(browser)[3]}\\NativeMessagingHosts\\${HOST_NAME}`
	try {
		execSync(`reg delete "${key}" /f`, { stdio: 'pipe' })
		return key
	} catch {
		return null
	}
}
function deleteBrowserManifest(browser) {
	const definition = BROWSERS.get(browser)
	const platform = process.platform
	const platformPath = definition?.[{ darwin: 1, linux: 2, win32: 3 }[platform]]
	if (!platformPath) return null
	if (platform === 'win32') return deleteWindowsRegistration(browser)
	const manifest = paths.join(system.homedir(), platformPath, `${HOST_NAME}.json`)
	try {
		filesystem.unlinkSync(manifest)
		return manifest
	} catch {
		return null
	}
}
function deleteWrapperDirectory() {
	const folder = wrapperDirectory()
	if (!folder) return null
	try {
		filesystem.rmSync(folder, { recursive: true, force: true })
		return folder
	} catch {
		return null
	}
}
function requestedRemoval(argumentsList) {
	const request = { browsers: ['chrome'], all: false }
	for (let position = 0; position < argumentsList.length; position += 1) {
		const item = argumentsList[position]
		if (item === '--browser' || item === '-b') {
			const target = argumentsList[++position]
			if (target === 'all') {
				request.browsers = Array.from(BROWSERS.keys())
				request.all = true
			} else {
				request.browsers = target.split(',').map((name) => name.trim().toLowerCase())
			}
		} else if (item === '--all' || item === '-a') {
			request.browsers = Array.from(BROWSERS.keys())
			request.all = true
		} else if (item === '--help' || item === '-h') {
			showHelp()
			process.exit(0)
		}
	}
	return request
}
const showHelp = () => console.log([
		"",
		"Lens Native Host Uninstaller",
		"",
		"Usage: uninstall-host.cjs [options]",
		"",
		"Options:",
		"  -b, --browser   Browser(s) to uninstall from (default: chrome)",
		"                  Values: chrome, chromium, brave, edge, arc, all",
		"  -a, --all       Uninstall from all browsers and remove wrapper",
		"",
		"Examples:",
		"  node uninstall-host.cjs",
		"  node uninstall-host.cjs --browser brave",
		"  node uninstall-host.cjs --all",
		"",
].join('\n'))
function reportRemoval(browsers, removeEverything) {
	const removed = []
	const missing = []
	for (const browser of browsers) {
		if (!BROWSERS.has(browser)) {
			console.error(`Unknown browser: ${browser}`)
			continue
		}
		const result = deleteBrowserManifest(browser)
		;(result ? removed : missing).push(
			result ? { browser: BROWSERS.get(browser)[0], path: result } : BROWSERS.get(browser)[0],
		)
	}
	if (removed.length) {
		console.log('Removed manifests:')
		for (const record of removed) console.log(`  ${record.browser}: ${record.path}`)
	}
	if (missing.length) console.log(`\nNot found: ${missing.join(', ')}`)
	if (removeEverything) {
		const folder = deleteWrapperDirectory()
		if (folder) console.log(`\nRemoved wrapper directory: ${folder}`)
	}
	console.log('\nDone!')
}
const { browsers, all } = requestedRemoval(process.argv.slice(2))
console.log(`Platform: ${process.platform}\n`)
reportRemoval(browsers, all)
