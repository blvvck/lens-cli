const filesystem = require('fs')
const paths = require('path')
const operatingSystem = require('os')
const CONFIG_NAME = 'lens.json'
const DEFAULT_REMINDER_POLICY = Object.freeze({
	enabled: true,
	slowThresholdMs: 30000,
	reminderCooldownMs: 60000,
})
let configSnapshot = null
let configOrigin = null
const INITIAL_SETTINGS = {
	autoSaveScreenshots: true,
	feedback: { reminders: { enabled: true, slowThresholdMs: 30000 } },
	routes: { main: ['http://localhost:3000'] },
}
function locateConfigurationFile() {
	const candidates = [
		paths.join(process.cwd(), CONFIG_NAME),
		paths.join(operatingSystem.homedir(), CONFIG_NAME),
	]
	return candidates.find((candidate) => filesystem.existsSync(candidate)) ?? null
}
function readConfiguration() {
	if (configSnapshot !== null) return configSnapshot
	const source = locateConfigurationFile()
	if (source === null) {
		configOrigin = null
		configSnapshot = {}
		return configSnapshot
	}
	try {
		const text = filesystem.readFileSync(source, 'utf-8')
		configSnapshot = JSON.parse(text)
		configOrigin = source
	} catch (error) {
		console.error(`Warning: Failed to parse ${source}: ${error.message}`)
		configSnapshot = {}
		configOrigin = null
	}
	return configSnapshot
}
function configurationFilePath() {
	if (configSnapshot === null) readConfiguration()
	return configOrigin
}
function writeInitialConfiguration(targetDir = process.cwd()) {
	const destination = paths.join(targetDir, CONFIG_NAME)
	if (filesystem.existsSync(destination)) {
		return { success: false, error: 'Config already exists', path: destination }
	}
	try {
		const serialized = `${JSON.stringify(INITIAL_SETTINGS, null, 2)}\n`
		filesystem.writeFileSync(destination, serialized)
		return { success: true, path: destination }
	} catch (error) {
		return { success: false, error: error.message, path: destination }
	}
}
function forgetConfiguration() {
	configSnapshot = null
	configOrigin = null
}
function parseBooleanSetting(input) {
	if (typeof input === 'boolean') return input
	if (typeof input !== 'string') return null
	const truthy = new Set(['true', '1', 'yes', 'on'])
	const falsy = new Set(['false', '0', 'no', 'off'])
	const token = input.trim().toLowerCase()
	if (truthy.has(token)) return true
	if (falsy.has(token)) return false
	return null
}
function parsePositiveInteger(input) {
	if (typeof input === 'number') {
		return Number.isInteger(input) && input > 0 ? input : null
	}
	if (typeof input !== 'string' || input.trim() === '') return null
	const parsed = Number.parseInt(input, 10)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
function feedbackReminderPolicy({ config = readConfiguration(), env = process.env } = {}) {
	const reminderSettings = config?.feedback?.reminders ?? {}
	const enabledFromEnvironment = parseBooleanSetting(env.LENS_FEEDBACK_REMINDERS)
	const enabledFromFile = parseBooleanSetting(reminderSettings.enabled)
	const threshold =
		parsePositiveInteger(env.LENS_FEEDBACK_SLOW_THRESHOLD_MS) ??
		parsePositiveInteger(reminderSettings.slowThresholdMs) ??
		DEFAULT_REMINDER_POLICY.slowThresholdMs
	return {
		enabled: enabledFromEnvironment ?? enabledFromFile ?? DEFAULT_REMINDER_POLICY.enabled,
		slowThresholdMs: threshold,
		reminderCooldownMs: DEFAULT_REMINDER_POLICY.reminderCooldownMs,
	}
}
exports.loadConfig = readConfiguration
exports.getConfigPath = configurationFilePath
exports.createStarterConfig = writeInitialConfiguration
exports.clearCache = forgetConfiguration
exports.STARTER_CONFIG = INITIAL_SETTINGS
exports.DEFAULT_FEEDBACK_REMINDER_POLICY = DEFAULT_REMINDER_POLICY
exports.getFeedbackReminderPolicy = feedbackReminderPolicy
