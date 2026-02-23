#!/usr/bin/env node
const filesystem = require('fs')
const paths = require('path')
const system = require('os')
const { execSync } = require('child_process')
const HOST_NAME = 'lens.browser.host'
const EXTENSION_ORIGIN = (id) => `chrome-extension://${id}/`
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
const knownNodeLocations = {
	darwin: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
	linux: ['/usr/bin/node', '/usr/local/bin/node'],
	win32: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'],
}
function locateNode() {
	const platform = process.platform
	const knownLocations = knownNodeLocations[platform] ?? []
	const foundLocation = knownLocations.find((candidate) => filesystem.existsSync(candidate))
	if (foundLocation) return foundLocation
	try {
		const lookup = platform === 'win32' ? 'where node' : 'which node'
		return execSync(lookup, { encoding: 'utf8' }).trim().split('\n')[0] || null
	} catch {
		return null
	}
}
const locateGlobalPackageRoot = () => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim() } catch { return null } }
const wrapperDirectory = () => ({
	darwin: paths.join(system.homedir(), 'Library/Application Support/lens-cli'),
	linux: paths.join(system.homedir(), '.local/share/lens-cli'),
	win32: paths.join(process.env.LOCALAPPDATA || paths.join(system.homedir(), 'AppData/Local'), 'lens-cli'),
})[process.platform] ?? null
const locateHostEntry = () => {
	const globalRoot = locateGlobalPackageRoot()
	return [
		globalRoot && paths.join(globalRoot, 'lens-cli/native/host/index.cjs'),
		paths.resolve(__dirname, '../native/host/index.cjs'),
	].filter(Boolean).find((candidate) => filesystem.existsSync(candidate)) ?? null
}
function writeLauncher(directory, nodeBinary, hostEntry) {
	filesystem.mkdirSync(directory, { recursive: true })
	if (process.platform === 'win32') {
		const launcher = paths.join(directory, 'host-wrapper.bat')
		filesystem.writeFileSync(launcher, `@echo off\r\n"${nodeBinary}" "${hostEntry}"\r\n`)
		return launcher
	}
	const launcher = paths.join(directory, 'host-wrapper.sh')
	const hostFolder = paths.dirname(hostEntry)
	filesystem.writeFileSync(
		launcher,
		`#!/bin/bash\ncd "${hostFolder}"\nexec "${nodeBinary}" "${hostEntry}"\n`,
	)
	filesystem.chmodSync(launcher, '755')
	return launcher
}
const buildManifest = (launcher, extensionId) => ({
	name: HOST_NAME,
	description: 'Lens Native Host',
	path: launcher,
	type: 'stdio',
	allowed_origins: [EXTENSION_ORIGIN(extensionId)],
})
function registerForWindows(browser, manifestPath) {
	const registryKey = `HKCU\\Software\\${BROWSERS.get(browser)[3]}\\NativeMessagingHosts\\${HOST_NAME}`
	try {
		execSync(`reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
			stdio: 'pipe',
		})
		return manifestPath
	} catch (error) {
		console.error(`Failed to add registry entry: ${error.message}`)
		return null
	}
}
function installForBrowser(browser, extensionId, launcher) {
	const definition = BROWSERS.get(browser)
	const platform = process.platform
	const platformPath = definition?.[{ darwin: 1, linux: 2, win32: 3 }[platform]]
	if (!platformPath) return null
	const manifest = buildManifest(launcher, extensionId)
	if (platform === 'win32') {
		const file = paths.join(wrapperDirectory(), `${HOST_NAME}.json`)
		filesystem.mkdirSync(paths.dirname(file), { recursive: true })
		filesystem.writeFileSync(file, JSON.stringify(manifest, null, 2))
		return registerForWindows(browser, file)
	}
	const folder = paths.join(system.homedir(), platformPath)
	const file = paths.join(folder, `${HOST_NAME}.json`)
	filesystem.mkdirSync(paths.dirname(file), { recursive: true })
	filesystem.writeFileSync(file, JSON.stringify(manifest, null, 2))
	return file
}
function requestedBrowsers(argumentsList) {
	const selection = { extensionId: null, browsers: ['chrome'] }
	for (let cursor = 0; cursor < argumentsList.length; cursor += 1) {
		const value = argumentsList[cursor]
		if (value === '--browser' || value === '-b') {
			const choice = argumentsList[++cursor]
			selection.browsers =
				choice === 'all'
			? Array.from(BROWSERS.keys())
					: choice.split(',').map((name) => name.trim().toLowerCase())
		} else if (value === '--help' || value === '-h') {
			showHelp()
			process.exit(0)
		} else if (!value.startsWith('-')) {
			selection.extensionId = value
		}
	}
	return selection
}
const showHelp = () => console.log([
		"",
		"Lens Native Host Installer",
		"",
		"Usage: install-host.cjs <extension-id> [options]",
		"",
		"Arguments:",
		"  extension-id    Chrome extension ID (32 lowercase letters a-p)",
		"                  Find at chrome://extensions with Developer Mode enabled",
		"",
		"Options:",
		"  -b, --browser   Browser(s) to install for (default: chrome)",
		"                  Values: chrome, chromium, brave, edge, arc, all",
		"                  Multiple: --browser chrome,brave",
		"",
		"Examples:",
		"  node install-host.cjs abcdefghijklmnopabcdefghijklmnop",
		"  node install-host.cjs abcdefghijklmnop --browser brave",
		"  node install-host.cjs abcdefghijklmnop --browser all",
		"",
].join('\n'))
function requireSetup(value, message, detail) {
	if (value) return
	console.error(`Error: ${message}`)
	if (detail) console.error(detail)
	process.exit(1)
}
	const { extensionId, browsers } = requestedBrowsers(process.argv.slice(2))
	requireSetup(
		extensionId,
		'Extension ID required',
		'Usage: install-host.cjs <extension-id> [--browser chrome|brave|edge|all]\n\nFind your extension ID at chrome://extensions (enable Developer Mode)',
	)
	requireSetup(
		/^[a-p]{32}$/.test(extensionId),
		'Invalid extension ID format',
		'Expected 32 lowercase letters (a-p)',
	)
	const nodeBinary = locateNode()
	requireSetup(
		nodeBinary,
		'Could not find Node.js',
		'Make sure Node.js is installed and in your PATH',
	)
	const hostEntry = locateHostEntry()
	requireSetup(hostEntry, 'Could not find host/index.cjs', 'Make sure lens-cli is installed correctly')
	const wrapperDir = wrapperDirectory()
	requireSetup(wrapperDir, 'Unsupported platform')
	console.log(`Platform: ${process.platform}`)
	console.log(`Node: ${nodeBinary}`)
	console.log(`Host: ${hostEntry}`)
	console.log(`Wrapper dir: ${wrapperDir}\n`)
	const launcher = writeLauncher(wrapperDir, nodeBinary, hostEntry)
	console.log(`Created wrapper: ${launcher}\n`)
	const installed = []
	const skipped = []
	for (const browser of browsers) {
		if (!BROWSERS.has(browser)) {
			console.error(`Unknown browser: ${browser}`)
			continue
		}
		const manifestPath = installForBrowser(browser, extensionId, launcher)
		;(manifestPath ? installed : skipped).push(
			manifestPath
				? { browser: BROWSERS.get(browser)[0], path: manifestPath }
				: BROWSERS.get(browser)[0],
		)
	}
	if (installed.length) {
		console.log('Installed for:')
		for (const item of installed) console.log(`  ${item.browser}: ${item.path}`)
	}
	if (skipped.length) {
		console.log(`\nSkipped (not supported on ${process.platform}): ${skipped.join(', ')}`)
	}
	console.log('\nDone! Restart your browser for changes to take effect.')
