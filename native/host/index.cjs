#!/usr/bin/env node
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const { execSync } = require('child_process')
const { mapToolToMessage, mapComputerAction, formatToolContent } = require('../routing/index.cjs')
const networkJournal = require('../network/journal.cjs')
const lanes = require('../runtime/lanes.cjs')
const {
	AUTO_INSPECT_DELAY_MS,
	formatAutoInspectContent,
} = require('../runtime/auto-inspect-policy.cjs')
const { getMimeType } = require('../runtime/fetch-policy.cjs')
const {
	cleanupEndpoint,
	clearCurrentProfile,
	ensureRuntimeDir,
	getHostLogPath,
	getProfileEndpoint,
	isWindows,
	registerProfile,
	unregisterProfile,
} = require('../runtime-paths.cjs')
let activeSocketPath = null
let activeProfileSlug = null
const cliConnections = new Set()
ensureRuntimeDir()
function resizeImageForHost(filePath, maxSize) {
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
const HOST_LOG_PATH = getHostLogPath()
const CREDENTIALS_FILE = path.join(os.homedir(), '.lens', 'auth.json')

function serveLocalResource(msg) {
	const { dir, urlPath, id } = msg
	try {
		if (!dir || !urlPath) {
			sendExtensionFrame({
				id,
				responseCode: 400,
				base64: Buffer.from('Bad Request').toString('base64'),
				mimeType: 'text/plain',
			})
			return
		}
		const resolvedDir = path.resolve(dir)
		let relPath = urlPath.startsWith('/') ? urlPath : '/' + urlPath
		let filePath = path.resolve(path.join(resolvedDir, relPath))
		if (!filePath.startsWith(resolvedDir)) {
			const html = `<!DOCTYPE html><html><body><h1>403</h1><p>Forbidden</p></body></html>`
			sendExtensionFrame({
				id,
				responseCode: 403,
				base64: Buffer.from(html).toString('base64'),
				mimeType: 'text/html',
				responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
			})
			return
		}
		if (!fs.existsSync(filePath)) {
			const html = `<!DOCTYPE html><html><body><h1>404</h1><p>Not Found: ${relPath}</p><hr><p style="color:#999">Lens CLI</p></body></html>`
			sendExtensionFrame({
				id,
				responseCode: 404,
				base64: Buffer.from(html).toString('base64'),
				mimeType: 'text/html',
				responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
			})
			return
		}
		const stat = fs.statSync(filePath)
		if (stat.isDirectory()) {
			const indexPath = path.join(filePath, 'index.html')
			if (fs.existsSync(indexPath)) {
				filePath = indexPath
			} else {
				const entries = fs.readdirSync(filePath, { withFileTypes: true }).map((e) => {
					const entryPath = path.join(filePath, e.name)
					return {
						name: e.name,
						isDir: e.isDirectory(),
						size: e.isDirectory() ? 0 : fs.statSync(entryPath).size,
					}
				})
				const listingPath = relPath.endsWith('/') ? relPath : relPath + '/'
				const html = renderDirectoryPage(listingPath, entries)
				sendExtensionFrame({
					id,
					responseCode: 200,
					base64: Buffer.from(html).toString('base64'),
					mimeType: 'text/html',
					responseHeaders: [
						{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
						{ name: 'Cache-Control', value: 'no-cache' },
					],
				})
				return
			}
		}
		const content = fs.readFileSync(filePath)
		const mimeType = getMimeType(filePath)
		sendExtensionFrame({
			id,
			responseCode: 200,
			base64: content.toString('base64'),
			mimeType,
			responseHeaders: [
				{ name: 'Content-Type', value: mimeType },
				{ name: 'Content-Length', value: String(content.length) },
				{ name: 'Cache-Control', value: 'no-cache' },
				{ name: 'Access-Control-Allow-Origin', value: '*' },
			],
		})
	} catch (e) {
		const html = `<!DOCTYPE html><html><body><h1>500</h1><p>${e.message}</p></body></html>`
		sendExtensionFrame({
			id,
			responseCode: 500,
			base64: Buffer.from(html).toString('base64'),
			mimeType: 'text/html',
			responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
		})
	}
}

function writeNetworkExport(msg) {
	const output = msg.output || path.join(os.tmpdir(), `lens-network-${Date.now()}.${msg.jsonl ? 'jsonl' : 'json'}`)
	try {
		const destination = path.resolve(output)
		fs.mkdirSync(path.dirname(destination), { recursive: true })
		fs.writeFileSync(destination, msg.content, 'utf8')
		sendExtensionFrame({ id: msg.id, path: destination })
	} catch (error) {
		sendExtensionFrame({ id: msg.id, error: `Failed to export network entries: ${error.message}` })
	}
}

function sendNetworkPaths(msg) {
	const entry = networkJournal.findRequestSync(msg.requestId)
	if (!entry) {
		sendExtensionFrame({ id: msg.id, error: `Entry not found: ${msg.requestId}` })
		return
	}
	const paths = {}
	if (entry.requestBodyHash) paths.request = networkJournal.getBodyFilePath(entry.requestBodyHash, true)
	if (entry.responseBodyHash) paths.response = networkJournal.getBodyFilePath(entry.responseBodyHash)
	sendExtensionFrame({ id: msg.id, paths })
}

function renderDirectoryPage(urlPath, entries) {
	const sorted = entries.sort((a, b) => {
		if (a.isDir && !b.isDir) return -1
		if (!a.isDir && b.isDir) return 1
		return a.name.localeCompare(b.name)
	})
	const parentPath = urlPath === '/' ? null : path.posix.dirname(urlPath.replace(/\/$/, '')) + '/'
	const parentLink = parentPath ? `<tr><td><a href="${parentPath}">../</a></td><td>-</td></tr>` : ''
	const rows = sorted
		.map((e) => {
			const href = urlPath + e.name + (e.isDir ? '/' : '')
			const display = e.name + (e.isDir ? '/' : '')
			const size = e.isDir
				? '-'
				: e.size < 1024
					? e.size + ' B'
					: e.size < 1048576
						? (e.size / 1024).toFixed(1) + ' KB'
						: (e.size / 1048576).toFixed(1) + ' MB'
			return `<tr><td><a href="${href}">${display}</a></td><td>${size}</td></tr>`
		})
		.join('')
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Index of ${urlPath}</title><style>body{font-family:-apple-system,sans-serif;max-width:900px;margin:40px auto;padding:0 20px}h1{font-size:1.2em;color:#333;border-bottom:1px solid #ddd;padding-bottom:8px}table{width:100%;border-collapse:collapse}td{padding:4px 12px}a{text-decoration:none;color:#2563eb}a:hover{text-decoration:underline}tr:hover{background:#f5f5f5}</style></head><body><h1>Index of ${urlPath}</h1><table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody>${parentLink}${rows}</tbody></table><p style="color:#999;font-size:0.8em;margin-top:20px">Served by Lens CLI</p></body></html>`
}

async function proxyHttpsRequest(msg, sendResponse) {
	const { url, method, headers, body, streamId } = msg
	writeHostLog(`"lens.nativeApi.request": ${method} ${url} streamId=${streamId}`)
	try {
		const urlObj = new URL(url)
		const options = {
			hostname: urlObj.hostname,
			port: urlObj.port || 443,
			path: urlObj.pathname + urlObj.search,
			method: method || 'POST',
			headers: headers || {},
		}
		const req = https.request(options, (res) => {
			writeHostLog(`API response status: ${res.statusCode}`)
			sendResponse({
				type: 'lens.nativeApi.responseStart',
				streamId,
				status: res.statusCode,
				headers: res.headers,
			})
			res.on('data', (chunk) => {
				sendResponse({
					type: 'lens.nativeApi.responseChunk',
					streamId,
					chunk: chunk.toString('utf8'),
				})
			})
			res.on('end', () => {
				sendResponse({
					type: 'lens.nativeApi.responseEnd',
					streamId,
				})
			})
			res.on('error', (err) => {
				writeHostLog(`API response error: ${err.message}`)
				sendResponse({
					type: 'lens.nativeApi.responseError',
					streamId,
					error: err.message,
				})
			})
		})
		req.on('error', (err) => {
			writeHostLog(`API request error: ${err.message}`)
			sendResponse({
				type: 'lens.nativeApi.responseError',
				streamId,
				error: err.message,
			})
		})
		if (body) {
			req.write(typeof body === 'string' ? body : JSON.stringify(body))
		}
		req.end()
	} catch (err) {
		writeHostLog(`API_REQUEST error: ${err.message}`)
		sendResponse({
			type: 'lens.nativeApi.responseError',
			streamId,
			error: err.message,
		})
	}
}

const writeHostLog = (msg) => {
	fs.appendFileSync(HOST_LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
}
writeHostLog('Host starting...')

function profileKeyFromEmail(email) {
	if (!email) return 'anon'
	return email
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40)
}

function bindProfileSocket(socketPath) {
	activeSocketPath = socketPath
	cleanupEndpoint(socketPath)
	server.listen(socketPath, () => {
		writeHostLog('Socket server listening on ' + socketPath)
		if (!isWindows()) {
			fs.chmodSync(socketPath, 0o600)
		}
	})
}
const forwardedFrames = new Map()
const toolReplies = new Map()
const browserStreams = new Map()
let requestCounter = 0

function replyToCli(socket, id, result, error) {
	const response = { type: 'lens.socket.toolResponse', id }
	if (error) {
		response.error = { content: [{ type: 'text', text: error }] }
	} else {
		response.result = { content: formatToolContent(result, writeHostLog) }
	}
	try {
		socket.write(JSON.stringify(response) + '\n')
	} catch (e) {
		writeHostLog(`Error sending "lens.socket.toolResponse": ${e.message}`)
	}
}

function beginBrowserStream(msg, socket) {
	const { streamType, options, id: originalId } = msg
	const tabId = msg.tabId
	const streamId = ++requestCounter
	browserStreams.set(streamId, {
		socket,
		originalId,
		streamType,
	})
	sendExtensionFrame({
		type: streamType,
		streamId,
		options: options || {},
		tabId,
	})
	try {
		socket.write(JSON.stringify({ type: 'stream_started', streamId }) + '\n')
	} catch (e) {
		writeHostLog(`Error sending stream_started: ${e.message}`)
	}
}

function dispatchToolCall(msg, socket) {
	const { method, params } = msg
	const originalId = msg.id || null
	if (method !== 'execute_tool') {
		replyToCli(socket, originalId, null, `Unknown method: ${method}`)
		return
	}
	const { tool, args } = params || {}
	const rawTabId = msg.tabId || params?.tabId || args?.tabId
	const tabId = rawTabId !== undefined ? parseInt(rawTabId, 10) : undefined
	const rawWindowId = msg.windowId || params?.windowId || args?.windowId
	const windowId = rawWindowId !== undefined ? parseInt(rawWindowId, 10) : undefined
	if (tabId !== undefined && isNaN(tabId)) {
		replyToCli(socket, originalId, null, 'tabId must be a number')
		return
	}
	if (windowId !== undefined && isNaN(windowId)) {
		replyToCli(socket, originalId, null, 'windowId must be a number')
		return
	}
	if (!tool) {
		replyToCli(socket, originalId, null, 'No tool specified')
		return
	}
	if (tool === 'diff') {
		const pathA = args?.pathA
		const pathB = args?.pathB
		const isRaw = args?.raw === true
		if (!pathA || !pathB) {
			replyToCli(socket, originalId, null, 'Two image paths required')
			return
		}
		if (!fs.existsSync(pathA)) {
			replyToCli(socket, originalId, null, `File not found: ${pathA}`)
			return
		}
		if (!fs.existsSync(pathB)) {
			replyToCli(socket, originalId, null, `File not found: ${pathB}`)
			return
		}
		const diffId = ++requestCounter
		const savePath = args?.output || path.join(path.dirname(pathA), 'diff-' + Date.now() + '.png')
		toolReplies.set(diffId, {
			socket,
			originalId,
			tool: 'diff',
			savePath,
		})
		const msgBase = {
			type: 'lens.page.diff',
			threshold: args?.threshold ?? 0.1,
			passThreshold: args?.passThreshold ?? 0,
			mode: args?.mode || 'pixel',
			id: diffId,
		}
		if (isRaw) {
			const rawWidth = args?.width
			const rawHeight = args?.height
			if (!rawWidth || !rawHeight) {
				replyToCli(socket, originalId, null, 'Raw mode requires --width and --height')
				return
			}
			const bufA = fs.readFileSync(pathA)
			const bufB = fs.readFileSync(pathB)
			const expectedBytes = rawWidth * rawHeight * 4
			if (bufA.length !== expectedBytes) {
				replyToCli(
					socket,
					originalId,
					null,
					`rawA size mismatch: expected ${expectedBytes} bytes (${rawWidth}x${rawHeight}x4), got ${bufA.length}`,
				)
				return
			}
			if (bufB.length !== expectedBytes) {
				replyToCli(
					socket,
					originalId,
					null,
					`rawB size mismatch: expected ${expectedBytes} bytes (${rawWidth}x${rawHeight}x4), got ${bufB.length}`,
				)
				return
			}
			const sharp = require('sharp')
			Promise.all([
				sharp(bufA, { raw: { width: rawWidth, height: rawHeight, channels: 4 } })
					.png({ compressionLevel: 1 })
					.toBuffer(),
				sharp(bufB, { raw: { width: rawWidth, height: rawHeight, channels: 4 } })
					.png({ compressionLevel: 1 })
					.toBuffer(),
			])
				.then(([pngA, pngB]) => {
					sendExtensionFrame({
						...msgBase,
						base64A: pngA.toString('base64'),
						base64B: pngB.toString('base64'),
					})
				})
				.catch((err) => {
					replyToCli(
						socket,
						originalId,
						null,
						`Failed to convert raw buffers to PNG: ${err.message}`,
					)
				})
		} else {
			const base64A = fs.readFileSync(pathA).toString('base64')
			const base64B = fs.readFileSync(pathB).toString('base64')
			sendExtensionFrame({ ...msgBase, base64A, base64B })
		}
		return
	}
	if (tool === 'dom-diff') {
		const pathA = args?.pathA
		const pathB = args?.pathB
		if (!pathA || !pathB) {
			replyToCli(socket, originalId, null, 'Two snapshot paths required')
			return
		}
		if (!fs.existsSync(pathA)) {
			replyToCli(socket, originalId, null, `File not found: ${pathA}`)
			return
		}
		if (!fs.existsSync(pathB)) {
			replyToCli(socket, originalId, null, `File not found: ${pathB}`)
			return
		}
		let snapshotA, snapshotB
		try {
			snapshotA = JSON.parse(fs.readFileSync(pathA, 'utf8'))
			snapshotB = JSON.parse(fs.readFileSync(pathB, 'utf8'))
		} catch (e) {
			replyToCli(socket, originalId, null, `Failed to parse snapshots: ${e.message}`)
			return
		}
		const domDiffId = ++requestCounter
		toolReplies.set(domDiffId, { socket, originalId, tool: 'dom-diff' })
		sendExtensionFrame({
			type: 'lens.page.domDiff',
			snapshotA,
			snapshotB,
			id: domDiffId,
		})
		return
	}
	if (tool === 'workspace.queue') {
		replyToCli(
			socket,
			originalId,
			{
				lanes: lanes.activeLanes(),
				queued: lanes.queuedCount(),
			},
			null,
		)
		return
	}
	const extensionMsg = mapToolToMessage(tool, args, tabId)
	if (!extensionMsg) {
		replyToCli(socket, originalId, null, `Unknown tool: ${tool}`)
		return
	}
	if (extensionMsg.type === 'lens.unsupported.unsupportedAction') {
		replyToCli(socket, originalId, null, extensionMsg.message)
		return
	}
	if (extensionMsg.type === 'wait') {
		setTimeout(() => {
			replyToCli(socket, originalId, { success: true }, null)
		}, extensionMsg.seconds * 1000)
		return
	}
	if (extensionMsg.type === 'lens.input.repeatKey') {
		const { key, repeat, delayMs = 50, tabId: tid } = extensionMsg
		let completed = 0
		let lastError = null
		const sendNextKey = () => {
			if (completed >= repeat) {
				if (lastError) {
					replyToCli(socket, originalId, null, `Key repeat failed: ${lastError}`)
				} else {
					replyToCli(socket, originalId, { success: true }, null)
				}
				return
			}
			const id = ++requestCounter
			toolReplies.set(id, {
				socket: null,
				originalId: null,
				tool,
				onComplete: (result) => {
					if (result.error) lastError = result.error
					completed++
					setTimeout(sendNextKey, delayMs)
				},
			})
			sendExtensionFrame({ type: 'lens.input.key', key, tabId: tid, id })
		}
		sendNextKey()
		return
	}
	if (extensionMsg.type === 'tab.switchByName' || extensionMsg.type === 'tab.closeByName') {
		const { name, type: opType } = extensionMsg
		const lookupId = ++requestCounter
		toolReplies.set(lookupId, {
			socket: null,
			originalId: null,
			tool: 'tab.lookup',
			onComplete: (result) => {
				if (result.error || !result.tabId) {
					replyToCli(
						socket,
						originalId,
						null,
						result.error || `No tab found with name "${name}"`,
					)
					return
				}
				const actionId = ++requestCounter
				const actionType = opType === 'tab.switchByName' ? 'tab.switch' : 'tab.close'
				toolReplies.set(actionId, { socket, originalId, tool, tabId: result.tabId })
				sendExtensionFrame({ type: actionType, tabId: result.tabId, id: actionId })
			},
		})
		sendExtensionFrame({ type: 'tab.getByName', name, id: lookupId })
		return
	}
	const id = ++requestCounter
	const pendingData = {
		socket,
		originalId,
		tool,
		savePath: extensionMsg.savePath || args?.savePath,
		autoInspect: args?.autoInspect,
		fullRes: extensionMsg.fullRes || args?.fullRes,
		maxSize: extensionMsg.maxSize || args?.maxSize,
		tabId: extensionMsg.tabId || tabId,
	}
	toolReplies.set(id, pendingData)
	const finalMsg = { ...extensionMsg, id }
	if (windowId) finalMsg.windowId = windowId
	lanes
		.submit(finalMsg, () => sendExtensionFrame(finalMsg), {
			isCancelled: () => pendingData.cancelled === true,
		})
		.then((release) => {
			pendingData.laneRelease = release
		})
}

function sendExtensionFrame(msg) {
	const json = JSON.stringify(msg)
	const len = Buffer.byteLength(json)
	const buf = Buffer.alloc(4 + len)
	buf.writeUInt32LE(len, 0)
	buf.write(json, 4)
	process.stdout.write(buf)
}
let inputBuffer = Buffer.alloc(0)

function consumeExtensionInput() {
	while (inputBuffer.length >= 4) {
		const msgLen = inputBuffer.readUInt32LE(0)
		if (inputBuffer.length < 4 + msgLen) break
		const jsonStr = inputBuffer.slice(4, 4 + msgLen).toString('utf8')
		inputBuffer = inputBuffer.slice(4 + msgLen)
		try {
			const msg = JSON.parse(jsonStr)
			writeHostLog(`Received from extension: ${JSON.stringify(msg)}`)
			if (msg.type === 'lens.profile.info') {
				const slug = profileKeyFromEmail(msg.email || '')
				const profileSocket = getProfileEndpoint(slug)
				writeHostLog(`Profile identified: ${msg.email || '(none)'}, socket: ${profileSocket}`)
				activeProfileSlug = slug
				registerProfile({ slug, endpoint: profileSocket, email: msg.email || null })
				if (!activeSocketPath) {
					bindProfileSocket(profileSocket)
				}
				continue
			}
			if (msg.type === 'lens.auth.get') {
				writeHostLog('Handling GET_AUTH from extension')
				try {
					if (fs.existsSync(CREDENTIALS_FILE)) {
						const authData = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
						sendExtensionFrame({ id: msg.id, auth: authData, hint: null })
					} else {
						sendExtensionFrame({
							id: msg.id,
							auth: null,
							hint: "No OAuth credentials found. Run 'pi --login anthropic' in terminal to authenticate with Claude Max.",
						})
					}
				} catch (e) {
					writeHostLog(`Error reading auth file: ${e.message}`)
					sendExtensionFrame({
						id: msg.id,
						auth: null,
						hint: "Failed to read auth credentials. Run 'pi --login anthropic' in terminal to authenticate.",
					})
				}
				return
			}
			if (msg.type === 'lens.nativeApi.request') {
				proxyHttpsRequest(msg, sendExtensionFrame)
				return
			}
			if (msg.type === 'lens.file.readLocal') {
				serveLocalResource(msg)
				return
			}
			if (msg.type === 'lens.network.export.write') {
				writeNetworkExport(msg)
				return
			}
			if (msg.type === 'lens.network.paths') {
				sendNetworkPaths(msg)
				return
			}
			if (msg.type === 'lens.event.stream') {
				const stream = browserStreams.get(msg.streamId)
				if (stream) {
					try {
						stream.socket.write(JSON.stringify(msg.event) + '\n')
					} catch (e) {
						writeHostLog(`Error forwarding stream event: ${e.message}`)
						browserStreams.delete(msg.streamId)
						sendExtensionFrame({ type: 'lens.stream.stop', streamId: msg.streamId })
					}
				}
				return
			}
			if (msg.type === 'lens.event.streamError') {
				const stream = browserStreams.get(msg.streamId)
				if (stream) {
					try {
						stream.socket.write(JSON.stringify({ error: msg.error }) + '\n')
					} catch (e) {}
					browserStreams.delete(msg.streamId)
				}
				return
			}
			if (msg.id && toolReplies.has(msg.id)) {
				const pending = toolReplies.get(msg.id)
				toolReplies.delete(msg.id)
				if (pending.laneRelease) {
					pending.laneRelease()
				}
				writeHostLog(
					`DEBUG: Received response for tool ${pending.tool}: ${JSON.stringify(msg).slice(0, 500)}`,
				)
				if (pending.onComplete) {
					pending.onComplete(msg)
				} else {
					const { socket, originalId, savePath, autoInspect, tabId: storedTabId } = pending
					const tabId = storedTabId || msg._resolvedTabId
					writeHostLog(
						`DEBUG: Sending tool response for ${pending.tool} to socket, originalId=${originalId}`,
					)
					if (pending.tool === 'dom-diff') {
						replyToCli(socket, originalId, msg, null)
						return
					}
					if (pending.tool === 'diff' && savePath && msg.base64) {
						try {
							const dir = path.dirname(savePath)
							if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
							fs.writeFileSync(savePath, Buffer.from(msg.base64, 'base64'))
							const diffResult = {
								path: savePath,
								width: msg.width,
								height: msg.height,
								mismatch: msg.mismatch,
								mismatchPixels: msg.mismatchPixels,
								totalPixels: msg.totalPixels,
								passed: msg.passed,
							}
							if (msg.mode === 'ssim') {
								diffResult.mode = 'ssim'
								diffResult.ssim = msg.ssim
								diffResult.mssim = msg.mssim
							}
							replyToCli(socket, originalId, diffResult, null)
						} catch (e) {
							replyToCli(socket, originalId, null, `Failed to save diff: ${e.message}`)
						}
						return
					}
					if (savePath && msg.base64) {
						try {
							const dir = path.dirname(savePath)
							if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
							fs.writeFileSync(savePath, Buffer.from(msg.base64, 'base64'))
							const origWidth = msg.width || 0
							const origHeight = msg.height || 0
							const maxSize = pending.maxSize || 1200
							const skipResize = pending.fullRes
							let finalDims = origWidth && origHeight ? `${origWidth}x${origHeight}` : ''
							if (!skipResize && (origWidth > maxSize || origHeight > maxSize)) {
								const result = resizeImageForHost(savePath, maxSize)
								if (result.success) {
									finalDims = `${result.width}x${result.height}, from ${origWidth}x${origHeight}`
								}
							}
							replyToCli(
								socket,
								originalId,
								{
									message: `Saved to ${savePath} (${finalDims})`,
									path: savePath,
									screenshotId: msg.screenshotId,
								},
								null,
							)
						} catch (e) {
							replyToCli(socket, originalId, null, `Failed to save: ${e.message}`)
						}
					} else if (autoInspect && tabId && !msg.error && !msg.base64) {
						const inspectId = ++requestCounter
						toolReplies.set(inspectId, {
							socket: null,
							originalId: null,
							tool: 'page.inspect',
							onComplete: (inspectMsg) => {
								replyToCli(
									socket,
									originalId,
									{
										...msg,
										autoInspect: formatAutoInspectContent(inspectMsg),
									},
									null,
								)
							},
						})
						setTimeout(() => {
							sendExtensionFrame({
								type: 'page.inspect',
								tabId,
								id: inspectId,
								options: { filter: 'interactive', includeText: true },
							})
						}, AUTO_INSPECT_DELAY_MS)
						return
					} else if (msg.results && msg.savePath) {
						try {
							const dir = msg.savePath
							if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
							for (const result of msg.results) {
								if (result.screenshotBase64 && result.hostname) {
									const ssPath = path.join(dir, `${result.hostname}.png`)
									fs.writeFileSync(ssPath, Buffer.from(result.screenshotBase64, 'base64'))
									result.screenshot = ssPath
									delete result.screenshotBase64
									delete result.hostname
								}
							}
							delete msg.savePath
							replyToCli(socket, originalId, msg, null)
						} catch (e) {
							replyToCli(socket, originalId, null, `Failed to save screenshots: ${e.message}`)
						}
					} else {
						const isPureError =
							msg.error &&
							!msg.success &&
							!msg.base64 &&
							!msg.pageContent &&
							!msg.tabs &&
							!msg.text &&
							!msg.output &&
							!msg.messages &&
							!msg.requests
						if (isPureError) {
							replyToCli(socket, originalId, null, msg.error)
						} else {
							replyToCli(socket, originalId, msg, null)
						}
					}
				}
			} else if (msg.id && forwardedFrames.has(msg.id)) {
				const { socket } = forwardedFrames.get(msg.id)
				try {
					socket.write(JSON.stringify(msg) + '\n')
				} catch (e) {
					writeHostLog(`Error writing to CLI socket: ${e.message}`)
				}
				forwardedFrames.delete(msg.id)
			}
		} catch (e) {
			writeHostLog(`Error parsing message: ${e.message}`)
		}
	}
}
process.stdin.on('readable', () => {
	let chunk
	while ((chunk = process.stdin.read()) !== null) {
		inputBuffer = Buffer.concat([inputBuffer, chunk])
		consumeExtensionInput()
	}
})
process.stdin.on('end', () => {
	writeHostLog('stdin ended (extension disconnected), notifying clients')
	for (const socket of Array.from(cliConnections)) {
		try {
			socket.write(
				JSON.stringify({
					type: 'lens.socket.extensionDisconnected',
					message: 'Lens extension was reloaded. Restart your command.',
				}) + '\n',
			)
			socket.end()
		} catch (e) {}
	}
	process.exit(0)
})
process.stdin.on('error', (err) => {
	writeHostLog(`stdin error: ${err.message}`)
})
process.stdout.on('error', (err) => {
	writeHostLog(`stdout error: ${err.message}`)
})

function writeCliFrame(socket, payload) {
	socket.write(`${JSON.stringify(payload)}\n`)
}

function answerAuthRequest(socket, id) {
	try {
		const response = { id: id || 0, auth: null, hint: null }
		if (fs.existsSync(CREDENTIALS_FILE)) {
			response.auth = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
		} else {
			response.hint = "No OAuth credentials found. Run 'pi --login anthropic' in terminal to authenticate with Claude Max."
		}
		writeCliFrame(socket, response)
	} catch (error) {
		writeHostLog(`Error reading auth file: ${error.message}`)
		writeCliFrame(socket, {
			id: id || 0,
			auth: null,
			hint: "Failed to read auth credentials. Run 'pi --login anthropic' in terminal to authenticate.",
		})
	}
}

function stopStreamsForClient(socket) {
	for (const [streamId, stream] of browserStreams) {
		if (stream.socket !== socket) continue
		sendExtensionFrame({ type: 'lens.stream.stop', streamId })
		browserStreams.delete(streamId)
	}
}

function acceptClientMessage(msg, socket) {
	if (msg.type === 'lens.auth.get') {
		writeHostLog('Handling GET_AUTH locally')
		answerAuthRequest(socket, msg.id)
		return
	}
	if (msg.type === 'lens.socket.toolRequest') {
		writeHostLog('Handling "lens.socket.toolRequest": ' + msg.method + ' ' + (msg.params?.tool || ''))
		try {
			dispatchToolCall(msg, socket)
		} catch (error) {
			writeCliFrame(socket, { error: error.message || 'Request failed' })
		}
		return
	}
	if (msg.type === 'stream_request') {
		writeHostLog('Handling stream_request: ' + msg.streamType)
		beginBrowserStream(msg, socket)
		return
	}
	if (msg.type === 'stream_stop') {
		writeHostLog('Handling stream_stop')
		stopStreamsForClient(socket)
		return
	}
	const id = ++requestCounter
	writeHostLog(`Forwarding to extension: id=${id} type=${msg.type}`)
	forwardedFrames.set(id, { socket })
	sendExtensionFrame({ ...msg, id })
}

function receiveClientLine(line, socket) {
	if (!line.trim()) return
	try {
		acceptClientMessage(JSON.parse(line), socket)
	} catch (error) {
		writeHostLog(`Error parsing CLI request: ${error.message}`)
		writeCliFrame(socket, { error: 'Invalid request' })
	}
}

function disconnectClient(socket) {
	writeHostLog('CLI client disconnected')
	for (const [id, pending] of forwardedFrames) {
		if (pending.socket === socket) forwardedFrames.delete(id)
	}
	for (const [id, pending] of toolReplies) {
		if (pending.socket !== socket || pending.autoInspect) continue
		pending.cancelled = !pending.laneRelease
		toolReplies.delete(id)
	}
	stopStreamsForClient(socket)
}

const server = net.createServer((socket) => {
	writeHostLog('CLI client connected')
	cliConnections.add(socket)
	socket.on('close', () => cliConnections.delete(socket))
	let pendingText = ''
	socket.on('data', (data) => {
		pendingText += data.toString()
		const frames = pendingText.split('\n')
		pendingText = frames.pop() || ''
		for (const frame of frames) receiveClientLine(frame, socket)
	})
	socket.on('error', (error) => writeHostLog(`CLI socket error: ${error.message}`))
	socket.on('close', () => disconnectClient(socket))
})

sendExtensionFrame({ type: 'lens.host.ready' })
writeHostLog('Sent HOST_READY, waiting for PROFILE_INFO from extension...')
server.on('error', (err) => {
	writeHostLog(`Server error: ${err.message}`)
})

function cleanup() {
	server.close()
	cleanupEndpoint(activeSocketPath)
	if (activeProfileSlug) unregisterProfile(activeProfileSlug)
	clearCurrentProfile(activeSocketPath)
}

process.on('SIGTERM', () => {
	writeHostLog('SIGTERM received')
	cleanup()
	process.exit(0)
})
process.on('SIGINT', () => {
	writeHostLog('SIGINT received')
	cleanup()
	process.exit(0)
})
process.on('uncaughtException', (err) => {
	writeHostLog(`Uncaught exception: ${err.message}\n${err.stack}`)
	process.exit(1)
})
writeHostLog('Host initialization complete, waiting for connections...')
