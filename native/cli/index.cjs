#!/usr/bin/env node
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { isBisectCommand, runBisectCommand } = require('../commands/bisect.cjs')
const {
	isHeadlessLifecycleCommand,
	routeHeadlessInvocation,
	runHeadlessCommand,
} = require('../commands/headless/index.cjs')
const { isCdpLifecycleCommand, runCdpCommand } = require('../commands/cdp/index.cjs')
const { getFeedbackBaseUrl } = require('../feedback/config.cjs')
const { isScriptRunnerInvocation, runScriptRunner } = require('../commands/script-runner.cjs')
const { loadConfig, getFeedbackReminderPolicy } = require('../config/index.cjs')
const traceFormat = require('../network/trace-format.cjs')
const networkJournal = require('../network/journal.cjs')
const { runTopLevelDispatch } = require('../commands/top-level-dispatch.cjs')
const { isMetaCommand, runMetaCommand } = require('../commands/meta/index.cjs')
const { shouldAutoInspectTool } = require('../runtime/auto-inspect-policy.cjs')
const {
	ensureRuntimeDir,
	getBrowserEndpoint,
	getCdpEndpoint,
	getCdpLogPath,
	getCdpPidPath,
	getCurrentProfile,
	getHeadlessEndpoint,
	getHeadlessLogPath,
	getHeadlessPidPath,
	getProfileEndpoint,
	getTmpDir,
	isWindows,
	listRegisteredProfiles,
	resolveProfile,
} = require('../runtime-paths.cjs')
const {
	COMMAND_REGISTRY,
	HELP_GROUPS,
	ALL_SOCKET_TOOLS,
	SEE_ALSO,
	getCommandMetadata,
	getPrimaryArgKey,
} = require('../commands/registry.cjs')
const { isFlowCommand, runFlowCommand } = require('../commands/flow/index.cjs')
const {
	queueFeedback,
	getStats,
	generateFeedbackId,
	getOrCreateClientCredentials,
	getClientCredentials,
	getClientCredentialsPath,
	readFeedback,
	recordDeliveryAttempt,
	markAsSent,
	listAll,
	listOutbox,
	prepareForRetry,
} = require('../feedback-outbox.cjs')
const {
	recordCommand,
	getLastCommand,
	previewLastContext,
	getRecentStats,
} = require('../feedback-recent.cjs')
const FRICTION_CONFIG = getFeedbackReminderPolicy({
	config: loadConfig(),
	env: process.env,
})
let lastReminderTime = 0
function emitFrictionHint({
	command,
	exitCode = 0,
	durationMs = 0,
	isJsCommand = false,
	stderrRef = process.stderr,
}) {
	if (!FRICTION_CONFIG.enabled) return
	const now = Date.now()
	if (now - lastReminderTime < FRICTION_CONFIG.reminderCooldownMs) return
	const hadError = exitCode !== 0
	const wasSlow = durationMs > FRICTION_CONFIG.slowThresholdMs
	if (!hadError && !wasSlow && !isJsCommand) return
	if (!hadError && !wasSlow && Math.random() > 0.3) return
	let hint = '💡 Something off? '
	if (hadError) hint += 'If this was unexpected, '
	else if (wasSlow) hint += 'That took a while. '
	else if (isJsCommand) hint += 'JS fallback used. '
	hint += `Send feedback: lens feedback --last "what happened"\n`
	stderrRef.write(hint)
	lastReminderTime = now
}
const REMOVED_AI_COMMANDS = new Set([
	'ai',
	['chat', 'gpt'].join(''),
	'gemini',
	'perplexity',
	'grok',
])
ensureRuntimeDir()
const DEFAULT_SOCKET = getBrowserEndpoint()
let SOCKET_PATH = DEFAULT_SOCKET
function locateProfileSocket(profileArg) {
	if (!profileArg) {

		const config = loadConfig()
		if (config.defaultProfile) return locateProfileSocket(config.defaultProfile)
		const currentProfile = getCurrentProfile()
		if (currentProfile?.endpoint) return currentProfile.endpoint
		const profiles = listRegisteredProfiles()
		if (profiles.length === 1) return profiles[0].endpoint
		return DEFAULT_SOCKET
	}
	const resolved = resolveProfile(profileArg)
	if (resolved.profile) return resolved.profile.endpoint
	if (resolved.matches.length > 1) {
		console.error(
			`Error: Ambiguous profile "${profileArg}". Matches: ${resolved.matches.map((profile) => profile.slug).join(', ')}`,
		)
		process.exit(1)
	}
	const exact = getProfileEndpoint(profileArg)
	if (!isWindows() && fs.existsSync(exact)) return exact
	console.error(`Error: No socket found for profile "${profileArg}". Use: lens profile.list`)
	process.exit(1)
}
SOCKET_PATH = locateProfileSocket()
function resizeScreenshot(filePath, maxSize) {
	const platform = process.platform
	try {
		if (platform === 'darwin') {
			execSync(
				`sips --resampleHeightWidthMax ${maxSize} "${filePath}" --out "${filePath}" 2>/dev/null`,
				{ stdio: 'pipe' },
			)
			const sizeInfo = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}" 2>/dev/null`, {
				encoding: 'utf8',
			})
			const width = parseInt(sizeInfo.match(/pixelWidth:\s*(\d+)/)?.[1] || '0', 10)
			const height = parseInt(sizeInfo.match(/pixelHeight:\s*(\d+)/)?.[1] || '0', 10)
			return { success: true, width, height }
		} else {
			try {
				execSync(`convert "${filePath}" -resize ${maxSize}x${maxSize}\\> "${filePath}"`, {
					stdio: 'pipe',
				})
			} catch {
				execSync(`magick "${filePath}" -resize ${maxSize}x${maxSize}\\> "${filePath}"`, {
					stdio: 'pipe',
				})
			}
			let sizeInfo
			try {
				sizeInfo = execSync(`identify -format "%w %h" "${filePath}"`, { encoding: 'utf8' })
			} catch {
				sizeInfo = execSync(`magick identify -format "%w %h" "${filePath}"`, { encoding: 'utf8' })
			}
			const [width, height] = sizeInfo.trim().split(' ').map(Number)
			return { success: true, width, height }
		}
	} catch (e) {
		return { success: false, error: e.message }
	}
}
const HEADLESS_SOCKET = getHeadlessEndpoint()
const HEADLESS_PID_FILE = getHeadlessPidPath()
const HEADLESS_LOG_FILE = getHeadlessLogPath()
const CDP_SOCKET = getCdpEndpoint()
const CDP_PID_FILE = getCdpPidPath()
const CDP_LOG_FILE = getCdpLogPath()
let args = process.argv.slice(2)
let isHeadlessMode = false
{
	const routedHeadless = routeHeadlessInvocation({
		args,
		headlessSocket: HEADLESS_SOCKET,
	})
	args = routedHeadless.args
	if (routedHeadless.isHeadlessMode) {
		isHeadlessMode = true
		SOCKET_PATH = routedHeadless.socketPath
	}
}
if (isCdpLifecycleCommand(args[0]) && !args.includes('--help') && !args.includes('-h')) {
	runCdpCommand({
		command: args[0],
		args,
		cdpSocket: CDP_SOCKET,
		cdpPidFile: CDP_PID_FILE,
		cdpLogFile: CDP_LOG_FILE,
		daemonPath: path.join(__dirname, '../cdp-daemon.cjs'),
		fsRef: fs,
		netRef: net,
		processRef: process,
		consoleRef: console,
		recordCommand,
	})
	return;
}
if (isHeadlessLifecycleCommand(args[0]) && !args.includes('--help') && !args.includes('-h')) {
	runHeadlessCommand({
		command: args[0],
		args,
		headlessSocket: HEADLESS_SOCKET,
		headlessPidFile: HEADLESS_PID_FILE,
		headlessLogFile: HEADLESS_LOG_FILE,
		daemonPath: path.join(__dirname, '../headless-daemon.cjs'),
		fsRef: fs,
		netRef: net,
		processRef: process,
		consoleRef: console,
		recordCommand,
	})
	return;
}
const VERSION = require('../../package.json').version
const TOOLS = HELP_GROUPS

const HELP_TOPICS = {
	refs: {
		title: 'Element References',
		content: [
			"Element refs (e1, e2, e3...) are stable identifiers from page.inspect.",
			"",
			"Usage:",
			"  1. Run page.inspect to get the accessibility tree",
			"  2. Find elements with refs like [e5] button \"Submit\"",
			"  3. Use the ref: click e5, scroll.to --ref e5, type \"text\" --ref e5",
			"",
			"Refs are more reliable than selectors for dynamic pages.",
		].join('\n'),
	},
	selectors: {
		title: 'CSS Selectors',
		content: [
			"Use CSS selectors when you know the element's structure.",
			"",
			"Examples:",
			"  click --selector \"#submit-btn\"",
			"  click --selector \".btn-primary\"",
			"  click --selector \"[data-testid='login']\"",
			"  click --selector \"button:contains('Submit')\"",
			"  wait.element \".loading-spinner\"",
			"",
			"Use --index to select from multiple matches:",
			"  click --selector \".item\" --index 2   # 3rd match (0-indexed)",
		].join('\n'),
	},
	cookies: {
		title: 'Cookie Management',
		content: [
			"Cookies are scoped to the current tab's domain.",
			"",
			"Commands:",
			"  cookie.list           List all cookies",
			"  cookie.get --name X   Get specific cookie",
			"  cookie.set            Set a cookie",
			"  cookie.clear          Clear cookies",
			"",
			"Notes:",
			"  - HttpOnly cookies are accessible",
			"  - Use --expires with ISO date: \"2025-12-31T00:00:00Z\"",
		].join('\n'),
	},
	screenshots: {
		title: 'Screenshots',
		content: [
			"Capture screenshots with various options.",
			"",
			"Commands:",
			"  screenshot --output file.png                          Basic screenshot",
			"  screenshot --annotate --output file.png               With element labels",
			"  screenshot --fullpage --output file.png               Full page capture",
			"  screenshot --annotate --fullpage --output file.png    Full page with labels",
			"  screenshot                                           Auto-save to /tmp by default",
			"",
			"Options:",
			"  --output      Save path",
			"  --annotate    Draw element refs",
			"  --fullpage    Capture entire page",
			"  --max-height  Max height for fullpage (default: 4000)",
		].join('\n'),
	},
	automation: {
		title: 'Automation Patterns',
		content: [
			"Common automation patterns:",
			"",
			"Wait for page load:",
			"  open \"https://example.com\"",
			"  wait.load",
			"",
			"Fill a form:",
			"  type \"user@email.com\" --into \"#email\"",
			"  type \"password123\" --into \"#password\"",
			"  click --selector \"button[type=submit]\"",
			"",
			"Wait for dynamic content:",
			"  click e5",
			"  wait.element \".results\"",
			"  page.inspect",
			"",
			"Scroll and capture:",
			"  scroll.bottom",
			"  screenshot --fullpage --output full.png",
		].join('\n'),
	},
	windows: {
		title: 'Window Isolation',
		content: [
			"Keep agent work separate from your browsing.",
			"",
			"Create a dedicated window:",
			"  lens window.new \"https://example.com\"",
			"  # Returns: Window 123 (tab 456)",
			"  # Use --window-id 123 to target this window",
			"",
			"All commands in that window:",
			"  lens open \"https://other.com\" --window-id 123",
			"  lens inspect --window-id 123",
			"  lens click e5 --window-id 123",
			"  lens capture --output /tmp/shot.png --window-id 123",
			"",
			"Manage windows:",
			"  lens window.list              # List all windows",
			"  lens window.list --tabs       # Include tab details  ",
			"  lens window.focus 123         # Bring window to front",
			"  lens window.close 123         # Close when done",
			"",
			"Tips:",
			"  - Agent commands won't affect your active browser window",
			"  - If window has no usable tabs, one is auto-created",
			"  - Use window.new --incognito for isolated cookies",
		].join('\n'),
	},
	semantic: {
		title: 'Semantic Locators',
		content: [
			"Find elements by role, text, or label instead of refs or selectors.",
			"",
			"By ARIA role:",
			"  locate.role button --name \"Submit\" --action click",
			"  locate.role textbox --name \"Email\" --action fill --value \"test@test.com\"",
			"  locate.role link --all                              # List all links",
			"",
			"By text content:",
			"  locate.text \"Sign In\" --action click",
			"  locate.text \"Accept\" --exact --action click         # Exact match",
			"",
			"By form label:",
			"  locate.label \"Username\" --action fill --value \"john\"",
			"  locate.label \"Password\" --action fill --value \"secret\"",
			"",
			"Available actions: click, fill, hover, text",
			"Without --action, returns the ref for later use.",
		].join('\n'),
	},
	frames: {
		title: 'Iframe Navigation',
		content: [
			"Work with embedded iframes.",
			"",
			"List frames:",
			"  frame.list                    # Show frame tree with IDs",
			"",
			"Switch context:",
			"  frame.switch --selector \"#payment-iframe\"",
			"  frame.switch --name \"checkout\"",
			"  frame.switch --index 0        # First iframe",
			"",
			"Return to main:",
			"  frame.main",
			"",
			"Execute JS in frame:",
			"  frame.js \"return document.title\" --id frame1",
			"",
			"After frame.switch, subsequent commands target that frame context.",
		].join('\n'),
	},
	devices: {
		title: 'Device Emulation',
		content: [
			"Test responsive designs and mobile views.",
			"",
			"Emulate a device:",
			"  emulate.device \"iPhone 16\"",
			"  emulate.device \"Pixel 7\"",
			"  emulate.device --list         # Show all devices",
			"  emulate.device \"reset\"        # Return to desktop",
			"  emulate.device custom --width 1280 --height 800 --scale 2",
			"",
			"Custom viewport:",
			"  emulate.viewport --width 375 --height 812",
			"  emulate.viewport --width 1920 --height 1080 --scale 2",
			"",
			"Touch events:",
			"  emulate.touch                 # Enable touch",
			"  emulate.touch --enabled false # Disable",
			"",
			"Device presets follow Chrome DevTools' standard emulation catalog.",
			"Use custom metrics for any viewport, scale, touch, or user-agent combination.",
		].join('\n'),
	},
	optimization: {
		title: 'Token Optimization',
		content: [
			"Reduce output size for LLM efficiency.",
			"",
			"Limit tree depth:",
			"  page.inspect --depth 3           # Max 3 levels deep",
			"",
			"Skip empty containers:",
			"  page.inspect --compact           # Remove empty structural elements",
			"",
			"Combine for best results:",
			"  page.inspect --depth 3 --compact # ~60% smaller output",
			"",
			"Filter to interactive only:",
			"  page.inspect                  # Default: interactive elements + visible text",
			"  page.inspect --all            # Include all elements",
			"",
			"Exclude text content:",
			"  page.inspect --no-text        # Skip visible text section",
		].join('\n'),
	},
}

const printQuickGuide = () => {
  console.log([
			"lens v" + VERSION + " - Browser automation by The Crux",
			'',
			"Usage: lens <command> [args] [options]",
			'',
			"Common Commands:",
			"  open <url>         Go to URL",
			"  click <ref>        Click element by ref or selector",
			"  type <text>        Type text at cursor or into element",
			"  screenshot         Capture screenshot",
			"  page.inspect       Get page accessibility tree",
			"  page.text          Extract all text from page",
			"  page.layout        Get visual layout tree",
			"  locate.role <role> Find element by ARIA role",
			"  search <term>      Search for text in page",
			"  window.new <url>   Create isolated browser window",
			"  wait <seconds>     Wait N seconds",
			'',
			"Quick Examples:",
			"  lens open \"https://example.com\"",
			"  lens page.inspect",
			"  lens click e5",
			"  lens type \"hello\" --submit",
			"  lens locate.role button --name \"Submit\" --action click",
			"  lens page.inspect --depth 3 --compact",
			"  lens emulate.device \"iPhone 16\"",
			"  lens window.new \"https://example.com\" && lens --window-id 123 open \"https://other.com\"",
			'',
			"More Help:",
			"  lens --help-full           All commands",
			"  lens --help-topic <topic>  Topic guide (refs, semantic, frames, devices...)",
			"  lens <command> --help      Command details",
			"  lens --find <query>        Search for commands",
			"  lens --about <topic>       Learn about a topic",
			'',
		].join('\n'));
}
const printCommandCatalog = () => {
  console.log([
			"lens v" + VERSION + " - Browser automation by The Crux",
			'',
			"Usage: lens <command> [args] [options]",
			'',
			'',
		].join('\n'));
  for (const [groupName, group] of Object.entries(TOOLS)) {
    console.log([
			groupName.toUpperCase() + " - " + group.desc,
		].join('\n'));
    for (const [cmd, info] of Object.entries(group.commands)) {
      const argStr = info.args?.length ? [
			"<" + info.args.join("> <") + ">",
		].join('\n') : "";
      const line = [
			"  " + cmd + " " + argStr,
		].join('\n').padEnd(32);
      console.log([
			line + info.desc,
		].join('\n'));
    }
    console.log();
  }
  console.log([
			"Options:",
			"  --tab-id <id>     Target specific tab",
			"  --window-id <id>  Target specific window (isolate from your browsing)",
			"  --profile <slug>  Target specific Chrome profile (see: lens profile.list)",
			"  --json            Output raw JSON",
			"  --auto-capture    On error: capture screenshot + console to /tmp",
			"  --soft-fail       On error: warn and exit 0 (for non-critical commands)",
			'',
			"Script Mode:",
			"  lens --script <file>     Run workflow from JSON",
			"  lens --script <file> --dry-run",
			'',
		].join('\n'));
}
const showHelpTopic = (topic) => {
	const t = HELP_TOPICS[topic]
	if (!t) {
		console.error(`Unknown topic: ${topic}`)
		console.error(`Available topics: ${Object.keys(HELP_TOPICS).join(', ')}`)
		process.exit(1)
	}
	console.log(`\n${t.title}\n${'='.repeat(t.title.length)}\n\n${t.content}\n`)
}
const printCommandGroup = (groupName) => {
	const group = TOOLS[groupName]
	if (!group) {
		console.error(`Unknown group: ${groupName}`)
		console.error(`Available groups: ${Object.keys(TOOLS).join(', ')}`)
		process.exit(1)
	}
	console.log(`\n${groupName} - ${group.desc}\n`)
	for (const [cmd, info] of Object.entries(group.commands)) {
		const argStr = info.args?.length ? `<${info.args.join('> <')}>` : ''
		console.log(`  ${cmd} ${argStr}`)
		console.log(`      ${info.desc}`)
		if (info.opts) {
			for (const [opt, desc] of Object.entries(info.opts)) {
				console.log(`      --${opt.padEnd(14)} ${desc}`)
			}
		}
		if (info.examples?.length) {
			console.log('      Examples:')
			for (const ex of info.examples) {
				console.log(`        lens ${ex.cmd}`)
			}
		}
		console.log()
	}
}
const printCommandDetails = (toolName) => {
	const metadata = getCommandMetadata(toolName)
	if (metadata) {
		const info = metadata.help
		const displayName = metadata.canonicalName
		const argStr = info.args?.length ? `<${info.args.join('> <')}>` : ''
		console.log(`\n${displayName} - ${info.desc}\n`)
		console.log(`Usage: lens ${displayName} ${argStr}\n`)
		if (info.args?.length) {
			console.log('Arguments:')
			for (const arg of info.args) {
				console.log(`  <${arg}>`)
			}
			console.log()
		}
		if (info.opts && Object.keys(info.opts).length > 0) {
			console.log('Options:')
			for (const [opt, desc] of Object.entries(info.opts)) {
				console.log(`  --${opt.padEnd(18)} ${desc}`)
			}
			console.log()
		}
		if (info.examples?.length) {
			console.log('Examples:')
			for (const ex of info.examples) {
				console.log(`  lens ${ex.cmd.padEnd(40)} ${ex.desc}`)
			}
			console.log()
		}
		const related = metadata.seeAlso || SEE_ALSO[displayName]
		if (related && related.length > 0) {
			console.log(`See also: ${related.join(', ')}`)
			console.log()
		}
		return
	}
	if (ALL_SOCKET_TOOLS.includes(toolName)) {
		console.log(`\n  ${toolName}\n`)
		console.log('  Socket API tool. Use --json to see response format.\n')
		const related = SEE_ALSO[toolName]
		if (related && related.length > 0) {
			console.log(`See also: ${related.join(', ')}`)
			console.log()
		}
		return
	}
	console.error(`Unknown command: ${toolName}`)
	process.exit(1)
}
const searchCommandCatalog = (query) => {
	const terms = query.toLowerCase().split(/\s+/)
	const results = []
	for (const entry of COMMAND_REGISTRY) {
		const searchText = `${entry.canonicalName} ${entry.help.desc} ${entry.helpGroup}`.toLowerCase()
		const score = terms.filter((t) => searchText.includes(t)).length
		if (score > 0) {
			results.push({
				cmd: entry.canonicalName,
				desc: entry.help.desc,
				group: entry.helpGroup,
				score,
			})
		}
	}
	return results.sort((a, b) => b.score - a.score)
}
const printCommandMatches = (query) => {
	const results = searchCommandCatalog(query)
	if (results.length === 0) {
		console.log(`No commands found for: "${query}"`)
		return
	}
	console.log(`\nSearch results for "${query}":\n`)
	for (const r of results.slice(0, 10)) {
		console.log(`  ${r.cmd.padEnd(24)} ${r.desc}`)
	}
	console.log()
}
const printTopicDetails = (topic) => {
	const t = HELP_TOPICS[topic]
	if (t) {
		showHelpTopic(topic)
		return
	}
	const topicLower = topic.toLowerCase()
	for (const [groupName, group] of Object.entries(TOOLS)) {
		if (groupName === topicLower || group.desc.toLowerCase().includes(topicLower)) {
			printCommandGroup(groupName)
			return
		}
	}
	console.error(`Unknown topic: ${topic}`)
	console.error(`Available topics: ${Object.keys(HELP_TOPICS).join(', ')}`)
	console.error(`Or use a group name: ${Object.keys(TOOLS).join(', ')}`)
	process.exit(1)
}
const printSocketTools = () => {
	console.log('\n  All available commands:\n')
	const sorted = [...ALL_SOCKET_TOOLS].sort()
	const cols = 4
	const width = 22
	for (let i = 0; i < sorted.length; i += cols) {
		const row = sorted
			.slice(i, i + cols)
			.map((t) => t.padEnd(width))
			.join('')
		console.log('  ' + row)
	}
	console.log(`\n  Total: ${ALL_SOCKET_TOOLS.length} commands\n`)
}
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
	printQuickGuide()
	process.exit(0)
}
if (args[0] === '--help-full') {
	printCommandCatalog()
	process.exit(0)
}
if (args[0] === '--help-topic' && args[1]) {
	showHelpTopic(args[1])
	process.exit(0)
}
const shouldHandleMetaCommand =
	isMetaCommand(args[0]) && !((args[0] === '--find' || args[0] === '--about') && !args[1])
if (shouldHandleMetaCommand) {
	runMetaCommand({
		command: args[0],
		args,
		version: VERSION,
		showAllTools: printSocketTools,
		showFindResults: printCommandMatches,
		showAbout: printTopicDetails,
		loadConfig,
		getCurrentProfile,
		listRegisteredProfiles,
		consoleRef: console,
		processRef: process,
		recordCommand,
	})
	return;
}
if ((args.includes('--help') || args.includes('-h')) && !(args[0] && args[0].startsWith('mail.'))) {
	const tool = args[0]
	if (tool === 'figma') {
		console.error('Figma browser commands were removed. Use the standalone lens-figma CLI with CDP or the companion plugin.')
		process.exit(1)
		return;
	}
	if (getCommandMetadata(tool) || ALL_SOCKET_TOOLS.includes(tool)) {
		printCommandDetails(tool)
	} else if (TOOLS[tool]) {
		printCommandGroup(tool)
	} else {
		printCommandDetails(tool)
	}
	process.exit(0)
}
if (TOOLS[args[0]] && args.length === 1) {
	const group = TOOLS[args[0]]
	const sameNameCmd = group.commands[args[0]]
	const executableAlone = ['zoom']
	if (sameNameCmd && executableAlone.includes(args[0])) {
	} else {
		printCommandGroup(args[0])
		process.exit(0)
	}
}
{
	const dispatchResult = runTopLevelDispatch({
		args,
		socketPath: SOCKET_PATH,
		recordCommand,
		loadConfig,
		processRef: process,
		consoleRef: console,
	})
	if (dispatchResult.handled) {
		SOCKET_PATH = dispatchResult.socketPath
		return;
	}
}
if (isScriptRunnerInvocation(args)) {
	runScriptRunner({ args, socketPath: SOCKET_PATH, consoleRef: console, processRef: process })
	return;
}
if (isBisectCommand(args[0])) {
	runBisectCommand({
		args: args.slice(1),
		consoleRef: console,
		processRef: process,
		processArgv: process.argv,
	})
	return;
}
const FEEDBACK_COMMANDS = new Set(['log', 'show', 'retry', 'status'])
const FEEDBACK_HTTP_TIMEOUT_MS = Number.parseInt(process.env.LENS_FEEDBACK_TIMEOUT_MS || '5000', 10)
function printFeedbackUsage() {
	console.error('Usage: lens feedback "Your feedback message"')
	console.error('       lens feedback --stdin')
	console.error('       lens feedback --last "Note about the last command"')
	console.error('       lens feedback --stdin --last')
	console.error('       lens feedback log [--json]')
	console.error('       lens feedback show <id> [--json]')
	console.error('       lens feedback retry [id] [--json]')
	console.error('       lens feedback status [--json]')
}
function readFeedbackNoteFromStdin() {
	if (process.stdin.isTTY === true) {
		throw new Error('--stdin requires piped or heredoc input')
	}
	const rawInput = fs.readFileSync(0, 'utf8')
	const note = rawInput.trim()
	if (!note) {
		throw new Error('--stdin received empty input')
	}
	return note
}
function stripFeedbackControlFlags(feedbackArgs) {
	return feedbackArgs.filter((arg) => arg !== '--json')
}
function isFeedbackJsonMode(feedbackArgs) {
	return feedbackArgs.includes('--json')
}
function formatFeedbackTimestamp(timestamp) {
	if (!timestamp) return '-'
	try {
		return new Date(timestamp).toISOString()
	} catch {
		return '-'
	}
}
function formatFeedbackNotePreview(note, maxLength = 72) {
	if (!note) return ''
	const flattened = String(note).replace(/\s+/g, ' ').trim()
	if (flattened.length <= maxLength) {
		return flattened
	}
	return `${flattened.slice(0, maxLength - 3)}...`
}
function sortFeedbackRecords(records) {
	return [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}
function resolveFeedbackApiBaseUrl() {
	const rawValue = getFeedbackBaseUrl(process.env)
	if (!rawValue) {
		return null
	}
	let baseUrl = rawValue.trim().replace(/\/+$/, '')
	baseUrl = baseUrl.replace(/\/api\/v1\/feedback\/ingest$/, '')
	baseUrl = baseUrl.replace(/\/api\/v1\/feedback$/, '')
	return baseUrl || null
}
function getFeedbackEndpointConfig() {
	const baseUrl = resolveFeedbackApiBaseUrl()
	if (!baseUrl) {
		return {
			configured: false,
			baseUrl: null,
			healthUrl: null,
			ingestUrl: null,
		}
	}
	return {
		configured: true,
		baseUrl,
		healthUrl: `${baseUrl}/health`,
		ingestUrl: `${baseUrl}/api/v1/feedback/ingest`,
	}
}
function parseFeedbackResponseBody(bodyText) {
	if (!bodyText) {
		return null
	}
	try {
		return JSON.parse(bodyText)
	} catch {
		return null
	}
}
async function checkFeedbackEndpointHealth(endpointConfig = getFeedbackEndpointConfig()) {
	if (!endpointConfig.configured) {
		return {
			configured: false,
			available: false,
			url: null,
			statusCode: null,
			latencyMs: null,
			error: 'Feedback endpoint is not configured',
		}
	}
	if (typeof fetch !== 'function') {
		return {
			configured: true,
			available: false,
			url: endpointConfig.healthUrl,
			statusCode: null,
			latencyMs: null,
			error: 'This Node runtime does not provide fetch()',
		}
	}
	const controller = new AbortController()
	const startedAt = Date.now()
	const timeoutId = setTimeout(() => controller.abort(), FEEDBACK_HTTP_TIMEOUT_MS)
	try {
		const response = await fetch(endpointConfig.healthUrl, {
			method: 'GET',
			signal: controller.signal,
		})
		return {
			configured: true,
			available: response.ok,
			url: endpointConfig.healthUrl,
			statusCode: response.status,
			latencyMs: Date.now() - startedAt,
			error: response.ok ? null : `Health check returned HTTP ${response.status}`,
		}
	} catch (err) {
		const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
		return {
			configured: true,
			available: false,
			url: endpointConfig.healthUrl,
			statusCode: null,
			latencyMs: Date.now() - startedAt,
			error: isAbort ? `Health check timed out after ${FEEDBACK_HTTP_TIMEOUT_MS}ms` : err.message,
		}
	} finally {
		clearTimeout(timeoutId)
	}
}
function buildFeedbackDeliveryPayload(record, clientCredentials) {
	return {
		id: record.id,
		note: record.note,
		context: record.context || undefined,
		commandSummary: record.commandSummary || undefined,
		clientId: clientCredentials.clientId,
		clientVersion: record.clientVersion || VERSION,
		platform: {
			os: process.platform,
			arch: process.arch,
		},
	}
}
async function deliverFeedbackRecord(record, endpointConfig = getFeedbackEndpointConfig()) {
	if (!record) {
		return {
			id: null,
			outcome: 'missing',
			error: 'Feedback record not found',
		}
	}
	if (!endpointConfig.configured) {
		return {
			id: record.id,
			outcome: 'queued',
			error: 'Feedback endpoint is not configured',
			delivered: false,
		}
	}
	if (typeof fetch !== 'function') {
		return {
			id: record.id,
			outcome: 'failed',
			error: 'This Node runtime does not provide fetch()',
			delivered: false,
		}
	}
	const clientCredentials = getOrCreateClientCredentials()
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), FEEDBACK_HTTP_TIMEOUT_MS)
	try {
		const response = await fetch(endpointConfig.ingestUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Client-ID': clientCredentials.clientId,
			},
			body: JSON.stringify(buildFeedbackDeliveryPayload(record, clientCredentials)),
			signal: controller.signal,
		})
		const bodyText = await response.text()
		const parsedBody = parseFeedbackResponseBody(bodyText)
		if (!response.ok) {
			const serverError =
				parsedBody?.error ||
				parsedBody?.message ||
				(bodyText ? bodyText.trim() : null) ||
				`HTTP ${response.status}`
			const isAmbiguous = response.status >= 500
			const updatedRecord = recordDeliveryAttempt(record.id, {
				success: false,
				ackUnknown: isAmbiguous,
				error: serverError,
			})
			return {
				id: record.id,
				outcome: isAmbiguous ? 'ack_unknown' : 'failed',
				error: serverError,
				delivered: false,
				record: updatedRecord,
			}
		}
		const acknowledgedAt = parsedBody?.data?.receivedAt || Date.now()
		const serverFeedbackId = parsedBody?.data?.serverFeedbackId || null
		recordDeliveryAttempt(record.id, {
			success: true,
			serverFeedbackId,
			serverTimestamp: acknowledgedAt,
		})
		const sentRecord = markAsSent(record.id)
		return {
			id: record.id,
			outcome: 'sent',
			error: null,
			delivered: true,
			record: sentRecord,
		}
	} catch (err) {
		const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
		const updatedRecord = recordDeliveryAttempt(record.id, {
			success: false,
			ackUnknown: isAbort,
			error: err.message,
		})
		return {
			id: record.id,
			outcome: isAbort ? 'ack_unknown' : 'failed',
			error: err.message,
			delivered: false,
			record: updatedRecord,
		}
	} finally {
		clearTimeout(timeoutId)
	}
}
function buildFeedbackStatusPayload({ stats, clientCredentials, endpointStatus, createdClient }) {
	return {
		stats,
		client: clientCredentials
			? {
					status: 'ready',
					clientId: clientCredentials.clientId,
					createdAt: clientCredentials.createdAt,
					credentialsPath: getClientCredentialsPath(),
					createdThisRun: createdClient,
				}
			: {
					status: 'missing',
					clientId: null,
					createdAt: null,
					credentialsPath: getClientCredentialsPath(),
					createdThisRun: false,
				},
		endpoint: endpointStatus,
	}
}
function printFeedbackLog(records) {
	if (records.length === 0) {
		console.log('No feedback records found.')
		return
	}
	console.log(`Feedback records: ${records.length}`)
	console.log('')
	for (const record of records) {
		console.log(record.id)
		console.log(`  Status:       ${record.status || 'queued'}`)
		console.log(`  Created:      ${formatFeedbackTimestamp(record.createdAt)}`)
		console.log(`  Last attempt: ${formatFeedbackTimestamp(record.lastAttemptAt)}`)
		console.log(
			`  Sent:         ${formatFeedbackTimestamp(record.serverAck?.timestamp || record.movedToSentAt)}`,
		)
		console.log(`  Note:         ${formatFeedbackNotePreview(record.note)}`)
		if (record.lastError) {
			console.log(`  Last error:   ${record.lastError}`)
		}
		console.log('')
	}
}
function printFeedbackStatus(statusPayload) {
	const { stats, client, endpoint } = statusPayload
	const queuedCount = stats.outboxByStatus?.queued || 0
	const failedCount = stats.outboxByStatus?.failed || 0
	const ambiguousCount = stats.outboxByStatus?.ack_unknown || 0
	console.log('Feedback status')
	console.log('')
	console.log(`Outbox: ${stats.outboxCount} pending`)
	console.log(`  queued=${queuedCount} failed=${failedCount} ack_unknown=${ambiguousCount}`)
	console.log(`Sent: ${stats.sentCount}`)
	console.log(`Last sent: ${formatFeedbackTimestamp(stats.lastSent)}`)
	console.log(`Last send error: ${stats.lastError || '-'}`)
	console.log('')
	console.log(
		`Client credentials: ${client.status}${client.clientId ? ` (${client.clientId})` : ''}`,
	)
	console.log(`Credentials path: ${client.credentialsPath}`)
	console.log(`Created at: ${formatFeedbackTimestamp(client.createdAt)}`)
	console.log('')
	if (!endpoint.configured) {
		console.log('Endpoint: unconfigured')
		console.log(
			'Set LENS_FEEDBACK_API or LENS_FEEDBACK_URL to use a custom endpoint, or remove blank overrides to use the default worker.',
		)
		return
	}
	console.log(`Endpoint: ${endpoint.available ? 'reachable' : 'unreachable'}`)
	console.log(`Health URL: ${endpoint.url}`)
	console.log(`Status code: ${endpoint.statusCode || '-'}`)
	console.log(`Latency: ${endpoint.latencyMs != null ? `${endpoint.latencyMs}ms` : '-'}`)
	console.log(`Health error: ${endpoint.error || '-'}`)
}
async function runFeedbackCommand(feedbackArgs) {
	const jsonMode = isFeedbackJsonMode(feedbackArgs)
	const filteredArgs = stripFeedbackControlFlags(feedbackArgs)
	const subcommand = filteredArgs[0]
	if (subcommand === 'log') {
		if (filteredArgs.length !== 1) {
			console.error('Error: feedback log does not take extra arguments')
			printFeedbackUsage()
			return 1
		}
		const records = sortFeedbackRecords(listAll())
		if (jsonMode) {
			console.log(JSON.stringify(records, null, 2))
			return 0
		}
		printFeedbackLog(records)
		return 0
	}
	if (subcommand === 'show') {
		const feedbackId = filteredArgs[1]
		if (filteredArgs.length !== 2 || !feedbackId) {
			console.error('Error: feedback show requires an id')
			printFeedbackUsage()
			return 1
		}
		const record = readFeedback(feedbackId)
		if (!record) {
			console.error(`Error: Feedback record not found: ${feedbackId}`)
			return 1
		}
		console.log(JSON.stringify(record, null, 2))
		return 0
	}
	if (subcommand === 'status') {
		if (filteredArgs.length !== 1) {
			console.error('Error: feedback status does not take extra arguments')
			printFeedbackUsage()
			return 1
		}
		const existingClient = getClientCredentials()
		let clientCredentials = existingClient
		let createdClient = false
		try {
			clientCredentials = clientCredentials || getOrCreateClientCredentials()
			createdClient = !existingClient && Boolean(clientCredentials)
		} catch (err) {
			if (jsonMode) {
				console.log(
					JSON.stringify(
						{
							error: `Failed to initialize feedback client credentials: ${err.message}`,
						},
						null,
						2,
					),
				)
			} else {
				console.error(`Error: Failed to initialize feedback client credentials: ${err.message}`)
			}
			return 1
		}
		const statusPayload = buildFeedbackStatusPayload({
			stats: getStats(),
			clientCredentials,
			endpointStatus: await checkFeedbackEndpointHealth(),
			createdClient,
		})
		if (jsonMode) {
			console.log(JSON.stringify(statusPayload, null, 2))
			return 0
		}
		printFeedbackStatus(statusPayload)
		return 0
	}
	if (subcommand === 'retry') {
		const feedbackId = filteredArgs[1]
		if (filteredArgs.length > 2) {
			console.error('Error: feedback retry accepts at most one id')
			printFeedbackUsage()
			return 1
		}
		const endpointConfig = getFeedbackEndpointConfig()
		const retryableRecords = feedbackId
			? (() => {
					const record = readFeedback(feedbackId)
					return record ? [record] : []
				})()
			: sortFeedbackRecords(listOutbox())
		if (feedbackId && retryableRecords.length === 0) {
			console.error(`Error: Feedback record not found: ${feedbackId}`)
			return 1
		}
		if (retryableRecords.length === 0) {
			const emptyPayload = {
				retried: 0,
				sent: 0,
				queued: 0,
				failed: 0,
				ackUnknown: 0,
				skipped: 0,
				results: [],
			}
			if (jsonMode) {
				console.log(JSON.stringify(emptyPayload, null, 2))
			} else {
				console.log('Nothing to retry. The feedback outbox is empty.')
			}
			return 0
		}
		const results = []
		for (const originalRecord of retryableRecords) {
			if (!originalRecord || originalRecord.status === 'sent') {
				results.push({
					id: originalRecord?.id || feedbackId || null,
					outcome: 'skipped',
					error: 'Already sent',
				})
				continue
			}
			let recordForDelivery = originalRecord
			if (originalRecord.status === 'failed' || originalRecord.status === 'ack_unknown') {
				recordForDelivery = prepareForRetry(originalRecord.id) || originalRecord
			}
			if (!endpointConfig.configured) {
				results.push({
					id: recordForDelivery.id,
					outcome: 'queued',
					error: 'Feedback endpoint is not configured',
				})
				continue
			}
			const deliveryResult = await deliverFeedbackRecord(recordForDelivery, endpointConfig)
			results.push({
				id: deliveryResult.id,
				outcome: deliveryResult.outcome,
				error: deliveryResult.error || null,
			})
		}
		const summary = results.reduce(
			(acc, result) => {
				acc.retried += 1
				if (result.outcome === 'sent') acc.sent += 1
				else if (result.outcome === 'queued') acc.queued += 1
				else if (result.outcome === 'failed') acc.failed += 1
				else if (result.outcome === 'ack_unknown') acc.ackUnknown += 1
				else acc.skipped += 1
				return acc
			},
			{
				retried: 0,
				sent: 0,
				queued: 0,
				failed: 0,
				ackUnknown: 0,
				skipped: 0,
				results,
			},
		)
		if (jsonMode) {
			console.log(JSON.stringify(summary, null, 2))
			return 0
		}
		console.log(
			`Retry summary: ${summary.sent} sent, ${summary.queued} queued, ` +
				`${summary.failed} failed, ${summary.ackUnknown} ack_unknown, ${summary.skipped} skipped`,
		)
		for (const result of results) {
			const suffix = result.error ? ` (${result.error})` : ''
			console.log(`  ${result.id}: ${result.outcome}${suffix}`)
		}
		return 0
	}
	const hasLastFlag = filteredArgs.includes('--last')
	const hasStdinFlag = filteredArgs.includes('--stdin')
	const hasYesFlag = filteredArgs.includes('--yes')
	const noteArg = filteredArgs.find((arg) => !arg.startsWith('-'))
	const isReservedSubcommand = noteArg && FEEDBACK_COMMANDS.has(noteArg)
	let note = noteArg
	if (isReservedSubcommand && filteredArgs.length === 1) {
		console.error(`Error: Unknown feedback subcommand usage: ${noteArg}`)
		printFeedbackUsage()
		return 1
	}
	if (hasStdinFlag && noteArg) {
		console.error('Error: Use either an inline note or --stdin, not both')
		printFeedbackUsage()
		return 1
	}
	if (hasStdinFlag) {
		try {
			note = readFeedbackNoteFromStdin()
		} catch (err) {
			console.error(`Error: ${err.message}`)
			printFeedbackUsage()
			return 1
		}
	}
	if (!note && !hasLastFlag) {
		console.error('Error: Feedback note required')
		printFeedbackUsage()
		return 1
	}
	let context = null
	if (hasLastFlag) {
		const lastCmd = getLastCommand()
		if (!lastCmd) {
			console.error('Error: No recent command available for --last')
			console.error('Run a command first, then use feedback --last')
			return 1
		}
		context = previewLastContext()
		if (!hasYesFlag) {
			console.log('Feedback will include context from your last command:')
			console.log('')
			console.log(`  Command: ${context.command}`)
			console.log(`  Family:  ${context.commandFamily}`)
			console.log(`  Time:    ${new Date(context.timestamp).toLocaleString()}`)
			if (context.args?.length > 0) {
				console.log(`  Args:    ${JSON.stringify(context.args)}`)
			}
			if (Object.keys(context.options || {}).length > 0) {
				console.log(`  Options: ${JSON.stringify(context.options)}`)
			}
			console.log('')
			console.log('Use --yes to skip this preview.')
			console.log('')
		}
	}
	let record
	try {
		record = queueFeedback({
			id: generateFeedbackId(),
			note: note || '(no note provided)',
			context,
			clientVersion: VERSION,
			platform: `${process.platform} ${process.arch}`,
		})
	} catch (err) {
		console.error(`Error: Failed to queue feedback: ${err.message}`)
		return 1
	}
	const deliveryResult = await deliverFeedbackRecord(record)
	if (deliveryResult.outcome === 'sent') {
		if (jsonMode) {
			console.log(
				JSON.stringify(
					{
						id: record.id,
						outcome: 'sent',
					},
					null,
					2,
				),
			)
		} else {
			console.log(`Feedback sent: ${record.id}`)
		}
		return 0
	}
	const stats = getStats()
	if (jsonMode) {
		console.log(
			JSON.stringify(
				{
					id: record.id,
					outcome: deliveryResult.outcome,
					error: deliveryResult.error || null,
					outboxCount: stats.outboxCount,
				},
				null,
				2,
			),
		)
	} else {
		const suffix = deliveryResult.error ? ` (${deliveryResult.error})` : ''
		console.log(`Feedback queued: ${record.id} (outbox: ${stats.outboxCount} pending)${suffix}`)
	}
	return 0
}
if (args[0] === 'feedback') {
	void runFeedbackCommand(args.slice(1))
		.then((exitCode) => process.exit(exitCode))
		.catch((err) => {
			console.error(`Error: ${err.message}`)
			process.exit(1)
		})
	return;
}
const flagsWithoutValues = [
	'auto-capture',
	'cdp',
	'json',
	'stream',
	'dry-run',
	'stop-on-error',
	'fail-fast',
	'clear',
	'submit',
	'all',
	'case-sensitive',
	'hard',
	'annotate',
	'fullpage',
	'reset',
	'no-inspect',
	'no-screenshot',
	'full',
	'soft-fail',
	'has-body',
	'exclude-static',
	'v',
	'vv',
	'request',
	'by-tab',
	'har',
	'jsonl',
	'no-save',
	'no-auto-wait',
	'dom',
	'raw',
	'double',
]

function coerceFlagValue(raw) {
	if (raw === 'true') return true
	if (raw === 'false') return false
	if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
	if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw)
	return raw
}
function consumesLongValue(candidate) {
	return candidate !== undefined && !candidate.startsWith('--') && !candidate.startsWith('-')
}
function readLongFlag(rawArgs, index, parsed) {
	const name = rawArgs[index].slice(2)
	if (flagsWithoutValues.includes(name)) {
		parsed.switches[name] = true
		return index
	}
	const next = rawArgs[index + 1]
	parsed.switches[name] = consumesLongValue(next) ? coerceFlagValue(next) : true
	return consumesLongValue(next) ? index + 1 : index
}
function readShortFlag(rawArgs, index, parsed) {
	const token = rawArgs[index]
	if (token === '-v' || token === '-vv') {
		parsed.switches[token.slice(1)] = true
		return index
	}
	if (token.startsWith('-') && token.length === 2) {
		parsed.switches[token.slice(1)] = true
		return index
	}
	parsed.operands.push(token)
	return index
}
function parseCommandLine(rawArgs) {
	const parsed = { operands: [], switches: {} }
	for (let index = 0; index < rawArgs.length; index += 1) {
		index = rawArgs[index].startsWith('--')
			? readLongFlag(rawArgs, index, parsed)
			: readShortFlag(rawArgs, index, parsed)
	}
	return parsed
}
let { operands, switches } = parseCommandLine(args)
let tool = operands[0]
let initialOperand = operands[1]
if (!tool) {
	console.error('Error: No command specified')
	process.exit(1)
}
if (REMOVED_AI_COMMANDS.has(tool)) {
	console.error(`Error: Unknown command: ${tool}`)
	process.exit(1)
}

const config = loadConfig()
const autoSaveEnabled = config.autoSaveScreenshots !== false && !switches['no-save']
if (tool === 'screenshot' && !switches.output && !switches.savePath && autoSaveEnabled) {
	switches.savePath = path.join(getTmpDir(), `lens-shot-${Date.now()}.png`)
}
if (tool === 'test.smoke') {
	const smokeUrls = []
	const smokeArgs = args.slice(1)
	for (let i = 0; i < smokeArgs.length; i++) {
		const arg = smokeArgs[i]
		if (arg === '--urls') {
			i++
			while (i < smokeArgs.length && !smokeArgs[i].startsWith('--')) {
				smokeUrls.push(smokeArgs[i])
				i++
			}
			i--
		} else if (arg === '--routes') {
			switches.routes = smokeArgs[i + 1]
			i++
		} else if (arg === '--screenshot') {
			switches.screenshot = smokeArgs[i + 1]
			i++
		} else if (arg === '--fail-fast') {
			switches['fail-fast'] = true
		}
	}
	if (smokeUrls.length > 0) {
		switches.urls = smokeUrls
	}
}
const commandPayload = { ...switches }
if (tool === 'click' && initialOperand) {
	if (/^e\d+$/.test(initialOperand)) {
		commandPayload.ref = initialOperand
		initialOperand = undefined
	} else if (/^\d+$/.test(initialOperand) && operands[2] && /^\d+$/.test(operands[2])) {
		commandPayload.x = parseInt(initialOperand, 10)
		commandPayload.y = parseInt(operands[2], 10)
		initialOperand = undefined
	} else if (!commandPayload.selector && !commandPayload.x && !commandPayload.y) {
		tool = 'locate.text'
		commandPayload.text = initialOperand
		commandPayload.action = 'click'
		initialOperand = undefined
	}
}
if (tool === 'hover' && initialOperand && /^e\d+$/.test(initialOperand)) {
	commandPayload.ref = initialOperand
	initialOperand = undefined
}
if (tool === 'screenshot' && initialOperand && /^e\d+$/.test(initialOperand)) {
	commandPayload.ref = initialOperand
	initialOperand = undefined
}
if (initialOperand !== undefined) {
	const primaryKey = getPrimaryArgKey(tool)
	if (primaryKey && commandPayload[primaryKey] === undefined) {
		let val = initialOperand
		if (val === 'true') val = true
		else if (val === 'false') val = false
		else if (/^-?\d+$/.test(val)) val = parseInt(val, 10)
		commandPayload[primaryKey] = val
	}
}
if (tool === 'dropdown.choose') {
	if (
		commandPayload.target === undefined &&
		commandPayload.label === undefined &&
		commandPayload.selector === undefined &&
		operands[1] !== undefined
	) {
		commandPayload.target = operands[1]
	}
	if (commandPayload.value === undefined && operands[2] !== undefined) {
		commandPayload.value = operands[2]
	}
}
if (tool === 'js' && commandPayload.file) {
	try {
		commandPayload.code = fs.readFileSync(commandPayload.file, 'utf8')
		delete commandPayload.file
	} catch (e) {
		console.error(`Error: Failed to read file: ${e.message}`)
		process.exit(1)
	}
}
if (tool === 'diff') {
	if (switches.dom) {
		tool = 'dom-diff'
		if (operands.length < 3) {
			console.error('Usage: lens diff --dom <snapshot-a.json> <snapshot-b.json>')
			process.exit(1)
		}
		commandPayload.pathA = path.resolve(operands[1])
		commandPayload.pathB = path.resolve(operands[2])
	} else {
		if (operands.length < 3) {
			console.error(
				'Usage: lens diff <image-a> <image-b> [--output diff.png] [--threshold 0.1] [--mode pixel|ssim]',
			)
			console.error('       lens diff --raw <buffer-a.rgba> <buffer-b.rgba> --width W --height H')
			console.error('       lens diff --dom <snapshot-a.json> <snapshot-b.json>')
			process.exit(1)
		}
		commandPayload.pathA = path.resolve(operands[1])
		commandPayload.pathB = path.resolve(operands[2])
		if (switches.raw) {
			commandPayload.raw = true
			commandPayload.width = parseInt(switches.width, 10)
			commandPayload.height = parseInt(switches.height, 10)
			if (!commandPayload.width || !commandPayload.height) {
				console.error('Raw mode requires --width and --height (pixel dimensions)')
				process.exit(1)
			}
		}
		if (switches.mode) {
			commandPayload.mode = switches.mode
		}
	}
	initialOperand = undefined
}
if (tool === 'bisect') {
	if (!initialOperand) {
		console.error(
			"Usage: lens bisect <url> --good <commit> --bad <commit> [--threshold 5] [--setup 'npm run build']",
		)
		process.exit(1)
	}
	commandPayload.url = initialOperand
	initialOperand = undefined
}
if (tool === 'select' && operands.length > 2) {
	const values = operands.slice(2)
	commandPayload.values = values.length === 1 ? values[0] : values
} else if (tool === 'select' && operands.length === 2) {
	console.error('Error: select requires at least one value')
	console.error('Usage: lens select <selector> <value...>')
	process.exit(1)
}
if (commandPayload.into && !commandPayload.selector) {
	commandPayload.selector = commandPayload.into
	delete commandPayload.into
}
if (tool === 'dropdown.choose') {
	const target = commandPayload.label || commandPayload.selector || commandPayload.target
	if (!target) {
		console.error('Error: label-or-selector argument required')
		process.exit(1)
	}
	if (!commandPayload.value) {
		console.error('Error: value argument required')
		process.exit(1)
	}
}
if (tool === 'form.fill' && commandPayload.data === undefined) {
	console.error('Error: --data argument required')
	process.exit(1)
}
const browserScope = {}
if (tool === 'window.new' || commandPayload['new-window'] === true) {
	console.warn(
		'Warning: this creates a browser window and raises Chrome, interrupting whatever the user is doing. ' +
			'Omit --new-window to use a background tab instead.',
	)
}
if (commandPayload['tab-id'] !== undefined) {
	const tid = parseInt(commandPayload['tab-id'], 10)
	if (isNaN(tid)) {
		console.error('Error: --tab-id must be a number')
		process.exit(1)
	}
	browserScope.tabId = tid
	delete commandPayload['tab-id']
}
if (commandPayload['window-id'] !== undefined) {
	const wid = parseInt(commandPayload['window-id'], 10)
	if (isNaN(wid)) {
		console.error('Error: --window-id must be a number')
		process.exit(1)
	}
	browserScope.windowId = wid
	delete commandPayload['window-id']
}
if (commandPayload['profile'] !== undefined) {
	SOCKET_PATH = locateProfileSocket(String(commandPayload['profile']))
	delete commandPayload['profile']
}
if (commandPayload.cdp === true) {
	SOCKET_PATH = CDP_SOCKET
	delete commandPayload.cdp
}
if (commandPayload['network-path'] !== undefined) {
	networkJournal.setStorageRoot(commandPayload['network-path'])
	delete commandPayload['network-path']
}
const wantJson = commandPayload.json === true
delete commandPayload.json
const autoCapture = commandPayload['auto-capture'] === true
delete commandPayload['auto-capture']
const noScreenshot = commandPayload['no-screenshot'] === true
delete commandPayload['no-screenshot']
const softFail = commandPayload['soft-fail'] === true
delete commandPayload['soft-fail']
const noInspect = commandPayload['no-inspect'] === true
delete commandPayload['no-inspect']
if (shouldAutoInspectTool(tool, { noInspect })) {
	commandPayload.autoInspect = true
}
const outputPath = commandPayload.output
delete commandPayload.output
if (tool === 'diff' && outputPath) {
	commandPayload.output = path.resolve(outputPath)
}
if (tool === 'screenshot' && outputPath) {
	if (typeof outputPath !== 'string') {
		console.error('Error: --output requires a file path')
		process.exit(1)
	}
	commandPayload.savePath = outputPath
	if (switches.full) commandPayload.full = true
	if (switches['max-size']) commandPayload['max-size'] = switches['max-size']
}
const methodFlag = commandPayload.method
if (tool !== 'network') {
	delete commandPayload.method
}
const streamMode = commandPayload.stream === true
delete commandPayload.stream
const streamLevel = commandPayload.level
delete commandPayload.level
const streamFilter = commandPayload.filter
delete commandPayload.filter
let finalTool = tool
if (methodFlag === 'js') {
	if (tool === 'type') {
		if (!commandPayload.selector) {
			console.error('Error: --selector or --into required for type with --method js')
			process.exit(1)
		}
		finalTool = 'form.smart'
	} else if (tool === 'click') {
		if (!commandPayload.selector) {
			console.error('Error: --selector required for click with --method js')
			process.exit(1)
		}
		commandPayload.code = `document.querySelector(${JSON.stringify(commandPayload.selector)})?.click()`
		delete commandPayload.selector
		finalTool = 'js'
	}
} else if (methodFlag === 'cdp') {
	if (tool === 'form.smart') {
		finalTool = 'type'
	}
}
if (streamMode && (tool === 'console' || tool === 'network')) {
	const streamType = tool === 'console' ? 'lens.stream.console' : 'lens.stream.network'
	const streamOpts = {
		level: streamLevel,
		filter: streamFilter,
	}
	const formatTime = (ts) => {
		const d = new Date(ts)
		return d.toLocaleTimeString('en-US', {
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3,
		})
	}
	let connectionTimeout = null
	let receivedData = false
	const sock = net.createConnection(SOCKET_PATH, () => {
		const req = {
			type: 'stream_request',
			streamType,
			options: streamOpts,
			id: 'cli-stream-' + Date.now(),
			...browserScope,
		}
		sock.write(JSON.stringify(req) + '\n')
		connectionTimeout = setTimeout(() => {
			if (!receivedData) {
				console.error('Error: Stream connection timeout (10s) - no data received')
				sock.destroy()
				process.exit(1)
			}
		}, 10000)
	})
	let buf = ''
	sock.on('data', (d) => {
		if (!receivedData) {
			receivedData = true
			if (connectionTimeout) {
				clearTimeout(connectionTimeout)
				connectionTimeout = null
			}
		}
		buf += d.toString()
		const lines = buf.split('\n')
		buf = lines.pop()
		for (const line of lines) {
			if (!line.trim()) continue
			try {
				const msg = JSON.parse(line)
				if (msg.error) {
					console.error('Error:', msg.error)
					sock.end()
					process.exit(1)
				}
				if (msg.type === 'lens.socket.extensionDisconnected') {
					console.error(msg.message)
					sock.end()
					process.exit(1)
				}
				if (msg.type === 'stream_started') {
					continue
				}
				if (msg.type === 'console_event') {
					const { level, text, timestamp } = msg
					if (streamLevel && level !== streamLevel) continue
					console.log(`[console] [${level}] ${formatTime(timestamp)} ${text}`)
				} else if (msg.type === 'network_event') {
					const { method, url, status, duration } = msg
					if (streamFilter && !url.includes(streamFilter)) continue
					const statusStr = status !== undefined ? status : '...'
					const durationStr = duration !== undefined ? ` (${duration}ms)` : ''
					console.log(`[network] ${method} ${url} ${statusStr}${durationStr}`)
				}
			} catch {}
		}
	})
	sock.on('error', (e) => {
		if (e.code === 'ENOENT') {
			if (SOCKET_PATH !== DEFAULT_SOCKET) {
				console.error(
					`Error: Socket not found for profile (${SOCKET_PATH}). Is that Chrome profile open?`,
				)
				console.error('Use: lens profile.list')
			} else {
				console.error('Error: Socket not found. Is Chrome running with the Lens extension?')
			}
		} else {
			console.error('Error:', e.message)
		}
		process.exit(1)
	})
	process.on('SIGINT', () => {
		sock.write(JSON.stringify({ type: 'stream_stop' }) + '\n')
		sock.end()
		process.exit(0)
	})
	return;
}

const request = {
	type: 'lens.socket.toolRequest',
	method: 'execute_tool',
	params: { tool: finalTool, args: commandPayload },
	id: 'cli-' + Date.now(),
	...browserScope,
}

const sendRequest = (toolName, commandPayload = {}) => {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(SOCKET_PATH, () => {
			const req = {
				type: 'lens.socket.toolRequest',
				method: 'execute_tool',
				params: { tool: toolName, args: commandPayload },
				id: 'cli-' + Date.now() + '-' + Math.random(),
				...browserScope,
			}
			sock.write(JSON.stringify(req) + '\n')
		})
		let buf = ''
		sock.on('data', (d) => {
			buf += d.toString()
			const lines = buf.split('\n')
			buf = lines.pop()
			for (const line of lines) {
				if (!line.trim()) continue
				try {
					const resp = JSON.parse(line)
					if (resp.type === 'lens.socket.extensionDisconnected') {
						sock.end()
						reject(new Error(resp.message))
						return
					}
					sock.end()
					resolve(resp)
				} catch {
					sock.end()
					reject(new Error('Invalid JSON'))
				}
			}
		})
		sock.on('error', (e) => reject(e))
		let timeoutId
		timeoutId = setTimeout(() => {
			sock.destroy()
			reject(new Error('Timeout'))
		}, 5000)
		sock.on('close', () => clearTimeout(timeoutId))
	})
}
const performAutoCapture = async () => {
	const timestamp = Date.now()
	const screenshotPath = path.join(getTmpDir(), `lens-error-${timestamp}.png`)
	try {
		const [screenshotResp, consoleResp] = await Promise.all([
			sendRequest('screenshot', { savePath: screenshotPath }),
			sendRequest('console', {}),
		])
		if (screenshotResp.result) {
			console.error(`Auto-captured: ${screenshotPath}`)
		} else {
			console.error('Auto-captured: (screenshot failed)')
		}
		let consoleErrors = '(none)'
		const consoleText = consoleResp.result?.content?.[0]?.text
		if (consoleText) {
			try {
				const parsed = JSON.parse(consoleText)
				const msgs = parsed.messages || parsed || []
				const errors = msgs.filter((m) => m.level === 'error' || m.type === 'error')
				if (errors.length > 0) {
					consoleErrors = errors.map((e) => e.text || e.message || JSON.stringify(e)).join('\n  ')
				}
			} catch {
				consoleErrors = consoleText
			}
		}
		console.error(`Console errors: ${consoleErrors}`)
	} catch (captureErr) {
		console.error(`Auto-capture failed: ${captureErr.message}`)
	}
}
const socket = net.createConnection(SOCKET_PATH, () => {
	try {
		recordCommand({
			command: tool,
			args: commandPayload?._ || [],
			options: Object.fromEntries(Object.entries(commandPayload || {}).filter(([k]) => k !== '_')),
			commandFamily: 'browser',
			status: 'started',
		})
	} catch {}
	socket.write(JSON.stringify(request) + '\n')
})
const commandStartTime = Date.now()
const LONG_RUNNING_TOOLS = ['test.smoke']
const requestTimeout = LONG_RUNNING_TOOLS.includes(tool) ? 300000 : 30000
const timeout = setTimeout(() => {
	const durationMs = Date.now() - commandStartTime
	console.error(`Error: Request timed out (${requestTimeout / 1000}s)`)
	emitFrictionHint({ command: tool, exitCode: 1, durationMs, stderrRef: process.stderr })
	socket.destroy()
	process.exit(1)
}, requestTimeout)
let buffer = ''
socket.on('data', (data) => {
	buffer += data.toString()
	const lines = buffer.split('\n')
	buffer = lines.pop()
	for (const line of lines) {
		if (!line.trim()) continue
		try {
			const msg = JSON.parse(line)
			if (msg.type === 'lens.socket.extensionDisconnected') {
				clearTimeout(timeout)
				console.error(msg.message)
				emitFrictionHint({ command: tool, exitCode: 1, stderrRef: process.stderr })
				socket.end()
				process.exit(1)
			}
			handleResponse(msg).catch((err) => {
				console.error('Handler error:', err.message)
				process.exit(1)
			})
		} catch (e) {
			console.error('Invalid JSON response:', line)
			process.exit(1)
		}
	}
})
socket.on('error', (err) => {
	clearTimeout(timeout)
	const durationMs = Date.now() - commandStartTime
	emitFrictionHint({ command: tool, exitCode: 1, durationMs, stderrRef: process.stderr })
	if (err.code === 'ENOENT') {
		if (isHeadlessMode) {
			console.error('Error: Headless daemon not running. Start it with: lens headless.start')
		} else if (SOCKET_PATH !== DEFAULT_SOCKET) {
			console.error(
				`Error: Socket not found for profile (${SOCKET_PATH}). Is that Chrome profile open?`,
			)
			console.error('Use: lens profile.list')
		} else {
			console.error('Error: Socket not found. Is Chrome running with the Lens extension?')
		}
	} else if (err.code === 'ECONNREFUSED') {
		if (isHeadlessMode) {
			console.error(
				'Error: Headless daemon not responding. Try: lens headless.stop && lens headless.start',
			)
		} else {
			console.error('Error: Connection refused. Native host not running.')
		}
	} else {
		console.error('Error:', err.message)
	}
	process.exit(1)
})
socket.on('close', () => {
	clearTimeout(timeout)
})

async function handleResponse(response) {
	clearTimeout(timeout)
	if (response && typeof response === 'object' && response.workspaceWarning) {
		console.warn(`Warning: ${response.workspaceWarning}`)
	}
	if (response.error) {
		const errContent = response.error.content?.[0]?.text || JSON.stringify(response.error)
		const durationMs = Date.now() - commandStartTime
		if (softFail) {
			console.warn('Warning:', errContent)
			socket.end()
			process.exit(0)
		}
		console.error('Error:', errContent)
		emitFrictionHint({ command: tool, exitCode: 1, durationMs, stderrRef: process.stderr })
		if (autoCapture) {
			await performAutoCapture()
		}
		socket.end()
		process.exit(1)
	}
	const result = response.result?.content?.[0]?.text
	let data
	try {
		data = result ? JSON.parse(result) : response.result
	} catch {
		data = result || response.result
	}
	if (wantJson) {
		console.log(JSON.stringify(data, null, 2))
		socket.end()
		process.exit(0)
	}
	if (tool === 'diff' && data?.path) {
		if (data.mode === 'ssim') {
			const ssim = data.ssim ?? 0
			const passed = data.passed !== false
			const status = ssim >= 0.9999 ? 'IDENTICAL' : passed ? 'SIMILAR' : 'DIVERGENT'
			const color = ssim >= 0.9999 ? '\x1b[32m' : passed ? '\x1b[33m' : '\x1b[31m'
			const reset = '\x1b[0m'
			console.log(`${color}${status}${reset} — SSIM ${ssim.toFixed(4)} (1.0 = identical)`)
			console.log(`Heatmap saved to ${data.path} (${data.width}x${data.height})`)
			process.exit(ssim >= 0.9999 || passed ? 0 : 1)
		} else {
			const pct = data.mismatch ?? 0
			const status = pct === 0 ? 'IDENTICAL' : data.passed ? 'PASS' : 'CHANGED'
			const color = pct === 0 ? '\x1b[32m' : data.passed ? '\x1b[33m' : '\x1b[31m'
			const reset = '\x1b[0m'
			console.log(
				`${color}${status}${reset} — ${pct}% mismatch (${data.mismatchPixels || 0}/${data.totalPixels || 0} pixels)`,
			)
			console.log(`Diff saved to ${data.path} (${data.width}x${data.height})`)
			process.exit(pct === 0 || data.passed ? 0 : 1)
		}
	} else if (tool === 'dom-diff' && data?.changes) {
		const s = data.summary || {}
		const total = s.total || 0
		if (total === 0) {
			console.log('\x1b[32mIDENTICAL\x1b[0m — no structural changes detected')
		} else {
			console.log(`\x1b[31mCHANGED\x1b[0m — ${total} difference${total !== 1 ? 's' : ''}`)
			if (s.added) console.log(`  \x1b[32m+${s.added} added\x1b[0m`)
			if (s.removed) console.log(`  \x1b[31m-${s.removed} removed\x1b[0m`)
			if (s.changed) console.log(`  \x1b[33m~${s.changed} changed\x1b[0m`)
			if (s.moved) console.log(`  \x1b[36m>${s.moved} moved/resized\x1b[0m`)
			console.log('')
			for (const c of data.changes.slice(0, 30)) {
				const icon =
					c.type === 'added'
						? '\x1b[32m+'
						: c.type === 'removed'
							? '\x1b[31m-'
							: c.type === 'moved'
								? '\x1b[36m>'
								: '\x1b[33m~'
				console.log(`${icon} ${c.path}\x1b[0m`)
				console.log(`    ${c.details}`)
			}
			if (data.changes.length > 30) {
				console.log(`  ... and ${data.changes.length - 30} more`)
			}
		}
		process.exit(total > 0 ? 1 : 0)
	} else if (tool === 'screenshot' && data?.base64 && (outputPath || commandPayload.savePath)) {
		const saveTo = outputPath || commandPayload.savePath
		fs.writeFileSync(saveTo, Buffer.from(data.base64, 'base64'))
		const skipResize = switches.full || commandPayload.full
		const maxSize = parseInt(switches['max-size'] || commandPayload['max-size'] || '1200', 10)
		const origWidth = data.width || 0
		const origHeight = data.height || 0
		if (!skipResize && (origWidth > maxSize || origHeight > maxSize)) {
			const result = resizeScreenshot(saveTo, maxSize)
			if (result.success) {
				console.log(
					`Saved to ${saveTo} (${result.width}x${result.height}, resized from ${origWidth}x${origHeight})`,
				)
			} else {
				console.log(
					`Saved to ${saveTo} (${origWidth}x${origHeight}, resize failed: ${result.error})`,
				)
			}
		} else {
			console.log(`Saved to ${saveTo} (${origWidth}x${origHeight})`)
		}
	} else if (tool === 'screenshot' && data?.message) {
		console.log(data.message)
		if (data.screenshotId) {
			console.log(`[Screenshot ID: ${data.screenshotId}]`)
		}
	} else if (tool === 'tab.list') {
		const tabs = data?.tabs || data || []
		if (Array.isArray(tabs)) {
			if (tabs.length === 0) {
				if (browserScope.windowId) {
					console.log(
						`No tabs in window ${browserScope.windowId}. Window may not exist - use 'lens window.list' to verify.`,
					)
				} else {
					console.log('No tabs found.')
				}
			} else {
				for (const t of tabs) {
					console.log(`${t.id}\t${t.title}\t${t.url}`)
				}
			}
		} else {
			console.log(JSON.stringify(data, null, 2))
		}
	} else if (tool === 'tab.named') {
		const named = data?.tabs || data?.namedTabs || data || []
		if (Array.isArray(named)) {
			if (named.length === 0) {
				console.log('No named tabs')
			} else {
				for (const t of named) {
					console.log(`${t.name}\t${t.tabId}\t${t.title || ''}\t${t.url || ''}`)
				}
			}
		} else {
			console.log(JSON.stringify(data, null, 2))
		}
	} else if (tool === 'page.inspect' && data?.pageContent) {
		console.log(data.pageContent)
	} else if (tool === 'page.layout' && data?.layoutContent) {
		console.log(data.layoutContent)
	} else if (tool === 'page.text' && data?.text) {
		console.log(data.text)
	} else if (tool === 'emulate.device' && data?.devices) {
		console.log('Available devices:\n')
		const devices = data.devices
		for (const d of devices) {
			console.log(`  ${d}`)
		}
		console.log('\nUsage: lens emulate.device "<device name>"')
		console.log('Reset:  lens emulate.device "reset"')
	} else if (tool === 'js') {
		if (data?.result !== undefined) {
			const val = data.result.value ?? data.result
			console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2))
		} else {
			console.log(JSON.stringify(data, null, 2))
		}
		const durationMs = Date.now() - commandStartTime
		emitFrictionHint({
			command: tool,
			exitCode: 0,
			durationMs,
			isJsCommand: true,
			stderrRef: process.stderr,
		})
	} else if (tool === 'doctor') {
		if (data?.success) {
			const timeStr = data.time ? ` (${data.time}ms)` : ''
			if (data.status) {
				console.log(`OK: ${data.status}${timeStr}`)
			} else if (data.found) {
				console.log(`OK: element found${timeStr}`)
			} else {
				console.log(`OK${timeStr}`)
			}
		} else {
			console.log(JSON.stringify(data, null, 2))
		}
	} else if (tool === 'test.smoke' && data?.results) {
		const results = data.results
		const summary = data.summary || { pass: 0, fail: 0, total: results.length }
		for (const r of results) {
			const status = r.status === 'pass' ? 'PASS' : 'FAIL'
			const timeStr = r.time ? ` (${r.time}ms)` : ''
			const ssStr = r.screenshot ? ` [${r.screenshot}]` : ''
			console.log(`[${status}] ${r.url}${timeStr}${ssStr}`)
			if (r.errors && r.errors.length > 0) {
				for (const err of r.errors) {
					console.log(`  - ${err}`)
				}
			}
		}
		console.log('')
		console.log(`Summary: ${summary.pass} passed, ${summary.fail} failed, ${summary.total} total`)
		if (summary.fail > 0) {
			socket.end()
			process.exit(1)
		}
	} else if (tool === 'zoom' && data?.zoom !== undefined) {
		console.log(`Zoom: ${Math.round(data.zoom * 100)}%`)
	} else if (tool === 'back' || tool === 'forward') {
		console.log('OK')
	} else if (tool === 'network' && (data?.entries || data?.requests)) {
		const items = data.entries || data.requests || []
		if (items.length === 0) {
			console.log('No network requests captured')
		} else if (data._format === 'raw') {
			console.log(JSON.stringify(items, null, 2))
		} else {
			for (const req of items) {
				const status = req.status || '-'
				const method = (req.method || 'GET').padEnd(6)
				const type = (req.type || '').padEnd(10)
				const url = req.url || ''
				console.log(`${status} ${method} ${type} ${url}`)
			}
		}
	} else if (tool === 'network.get' && data?.entry) {
		console.log(traceFormat.entry(data.entry))
	} else if (tool === 'network.body' && data?.body !== undefined) {
		process.stdout.write(data.body)
	} else if (tool === 'network.curl' && data?.curl) {
		console.log(data.curl)
	} else if (tool === 'network.curl' && data?.entry) {
		console.log(traceFormat.curl(data.entry))
	} else if (tool === 'network.origins' && data?.origins) {
		console.log(traceFormat.origins(data.origins))
	} else if (tool === 'network.stats' && data?.stats) {
		console.log(traceFormat.stats(data.stats))
	} else if (tool === 'network.clear' && data?.cleared !== undefined) {
		console.log(`Cleared ${data.cleared} requests`)
	} else if (tool === 'network.export' && data?.path) {
		console.log(`Exported to: ${data.path}`)
	} else if (tool === 'network.path' && data?.paths) {
		for (const [key, val] of Object.entries(data.paths)) {
			console.log(`${key}: ${val}`)
		}
	} else if (tool === 'window.list' && data?.windows) {
		if (data.windows.length === 0) {
			console.log("No windows. Use 'lens window.new' to create one.")
		} else {
			for (const w of data.windows) {
				const focused = w.focused ? ' [focused]' : ''
				const state = w.state !== 'normal' ? ` (${w.state})` : ''
				console.log(`${w.id}\t${w.tabCount} tabs\t${w.width}x${w.height}${focused}${state}`)
				if (w.tabs) {
					for (const t of w.tabs) {
						const active = t.active ? '*' : ' '
						console.log(`  ${active} ${t.id}\t${t.title || '(no title)'}\t${t.url || ''}`)
					}
				}
			}
			if (data.windows.length > 0 && !browserScope.windowId) {
				console.log('\n[hint] Use --window-id <id> to isolate commands to a specific window')
			}
		}
	} else if (tool === 'extension.reload' && data?.reloading) {
		console.log('Lens extension reloading')
	} else if (typeof data === 'string') {
		console.log(data)
	} else if (data?.success === true) {
		console.log('OK')
	} else if (data?.error) {
		if (softFail) {
			console.warn('Warning:', data.error)
			socket.end()
			process.exit(0)
		}
		console.error('Error:', data.error)
		if (autoCapture) {
			await performAutoCapture()
		}
		socket.end()
		process.exit(1)
	} else {
		console.log(JSON.stringify(data, null, 2))
	}
	const durationMs = Date.now() - commandStartTime
	emitFrictionHint({ command: tool, exitCode: 0, durationMs, stderrRef: process.stderr })
	socket.end()
	process.exit(0)
}
