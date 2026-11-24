'use strict'

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { pathToFileURL } = require('node:url')

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 3000
const DEFAULT_LICHII_HOST = '127.0.0.1'
const DEFAULT_LICHII_PORT = 6545
const MAX_LOG_LINES = 500
const MAX_REDIRECTS = 5

const OFFICIAL_REPO_URL = 'https://github.com/antonioalvromero/Ocarina-Atlas'
const OFFICIAL_RELEASES_API_URL =
  'https://api.github.com/repos/antonioalvromero/Ocarina-Atlas/releases/latest'

const ALLOWED_GITHUB_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

const ALLOWED_EXTERNAL_HTTPS_HOSTS = new Set([
  'github.com',
  'www.github.com',
])

const RECOMP_PROCESS_NAMES = new Set([
  'hookshot',
  'longshot',
  'heylisten',
  'relink-game',
  'relink',
  'triforce',
  'rekarina',
  'ocarina',
  'nx2navi',
])

const DIRECT_HOST_VA_PROCESS_NAMES = new Set(['ocarina', 'nx2navi', 'rekarina'])

// NX2Saria serves the debug RPC on 127.0.0.1:6545 itself, so only its save folder is detected
const NX2SARIA_PROCESS_NAMES = new Set(['ocarina', 'nx2saria'])

const EMULATOR_PROCESS_NAMES = new Set([
  'lichii',
  'fritchii',
  'cheezyemu',
  'eden',
  'ocarina',
  'nx2saria',
])

const RUNTIME_DISPLAY_NAMES = {
  lichii: 'Lichii',
  fritchii: 'Fritchii',
  cheezyemu: 'CheezyEmu',
  eden: 'Eden',
  ocarina: 'NX2Saria',
  nx2saria: 'NX2Saria',
  ootpc: 'OOT-PC',
  nx2navi: 'OOT-PC',
  rekarina: 'Rekarina',
  hookshot: 'Hookshot',
  longshot: 'Longshot',
  heylisten: 'HeyListen',
  'relink-game': 'Project ReLink',
  relink: 'Project ReLink',
  triforce: 'Triforce',
}

const SYNC_PROFILE_NAMES = ['lichii', 'fritchii', 'eden', 'cheezyemu']
const SYNC_PROCESS_NAMES = new Set(SYNC_PROFILE_NAMES)
const MANDATORY_CONFIG_PROFILES = new Set(['lichii', 'fritchii'])

const VIRTUAL_ADAPTER_PATTERN =
  /(?:vethernet|hyper-v|wsl|virtualbox|vbox|vmware|docker|veth|utun|wintun|tailscale|zerotier|wireguard|nordlynx|radmin|hamachi|openvpn|bluetooth|loopback|npcap|isatap|teredo|\bbridge\d*\b|\btap(?:[\s_-]?\d+|\b)|\btun(?:[\s_-]?\d+|\b))/i

const WINDOW_WIDTH = 556
const WINDOW_HEIGHT_COMPACT = 480
const WINDOW_HEIGHT_EXPANDED = 820

const SUPPORTED_LANGUAGES = [
  'en',
  'es',
  'fr',
  'pt',
  'zh-CN',
  'zh-TW',
  'de',
  'it',
  'ja',
  'ko',
  'nl',
  'ru',
  'pl',
  'tr',
  'uk',
]

function sanitizeLichiiHost(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 253) return null
  if (/[\r\n\s\x00-\x1f\x7f]/.test(trimmed)) return null
  return trimmed
}

function parsePort(raw, fallback, allowZero = false) {
  const trimmed = String(raw ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  const n = Number.parseInt(trimmed, 10)
  const min = allowZero ? 0 : 1
  return Number.isInteger(n) && n >= min && n <= 65535 ? n : fallback
}

function getCliArgs() {
  const raw = process.argv
  if (process.defaultApp) {
    return raw.slice(2)
  }
  return raw.slice(1)
}

function parseArgs(argv, env = process.env) {
  const opts = {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT, DEFAULT_PORT, true),
    lichiiHost: sanitizeLichiiHost(env.LICHII_HOST || env.FRITCHII_HOST) || DEFAULT_LICHII_HOST,
    lichiiPort: parsePort(env.LICHII_PORT || env.FRITCHII_PORT, DEFAULT_LICHII_PORT, false),
    saveDir: env.CUSTOM_SAVE_DIR?.trim() || '',
    saveSlot: env.CUSTOM_SAVE_SLOT?.trim() || '',
    noBrowser: false,
    cli: false,
    lanExplicit: false,
    setupSync: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (!arg) continue
    const eqIdx = arg.indexOf('=')
    const key = eqIdx > 0 ? arg.slice(0, eqIdx) : arg
    const inlineVal = eqIdx > 0 ? arg.slice(eqIdx + 1) : undefined

    if (key === '--help' || key === '-h') {
      opts.help = true
    } else if (key === '--lan') {
      opts.host = DEFAULT_HOST
      opts.lanExplicit = true
    } else if (key === '--local-only' || key === '--localhost') {
      opts.host = '127.0.0.1'
      opts.lanExplicit = true
    } else if (key === '--no-browser') {
      opts.noBrowser = true
    } else if (key === '--cli' || key === '--no-gui') {
      opts.cli = true
    } else if (key === '--setup-sync') {
      opts.setupSync = true
    } else if (key === '--port') {
      const val = inlineVal ?? argv[++i]
      if (val === undefined) throw new Error('--port requires a value')
      const parsed = parsePort(val, -1, true)
      if (parsed < 0) throw new Error(`Invalid --port value: ${val}`)
      opts.port = parsed
    } else if (key === '--host') {
      const val = inlineVal ?? argv[++i]
      if (!val || !val.trim()) throw new Error('--host requires a value')
      opts.host = val.trim()
      opts.lanExplicit = true
    } else if (key === '--lichii-host') {
      const val = inlineVal ?? argv[++i]
      const sanitized = sanitizeLichiiHost(val)
      if (!sanitized) throw new Error('--lichii-host requires a valid host value')
      opts.lichiiHost = sanitized
    } else if (key === '--lichii-port') {
      const val = inlineVal ?? argv[++i]
      if (val === undefined) throw new Error('--lichii-port requires a value')
      const parsed = parsePort(val, -1, false)
      if (parsed < 1) throw new Error(`Invalid --lichii-port value: ${val}`)
      opts.lichiiPort = parsed
    } else if (key === '--save-dir') {
      const val = inlineVal ?? argv[++i]
      if (!val || !val.trim()) throw new Error('--save-dir requires a value')
      opts.saveDir = val.trim()
    } else if (key === '--save-slot') {
      const val = inlineVal ?? argv[++i]
      if (!val || !val.trim()) throw new Error('--save-slot requires a value')
      opts.saveSlot = val.trim()
    }
    // Ignore Electron/Chromium/macOS LaunchServices internal flags (e.g. --no-sandbox, -psn_...)
  }

  return opts
}

function printHelp(platformLabel, syncHelpLines = []) {
  const syncDoc =
    syncHelpLines.length > 0
      ? syncHelpLines.join('\n')
      : '  --setup-sync        Write EDEN_NX2_DEBUG_SERVER=<host>:<port> to emulator nx2_switches.txt and exit'
  console.log(`Ocarina Atlas — ${platformLabel} Launcher (${OFFICIAL_REPO_URL})

Usage: OcarinaAtlas [options]

Options:
  --port <n>          HTTP port for the map server (default: ${DEFAULT_PORT})
  --host <addr>       Bind address (default: ${DEFAULT_HOST})
  --lan               Bind all interfaces (${DEFAULT_HOST}) for phone/tablet access
  --local-only        Bind loopback only (127.0.0.1)
  --lichii-host <h>   Emulator/Lichii debug RPC host (default: ${DEFAULT_LICHII_HOST})
  --lichii-port <p>   Emulator/Lichii debug RPC port (default: ${DEFAULT_LICHII_PORT})
  --save-dir <path>   Custom save folder path (overrides auto-detection)
  --save-slot <slot>  Preferred save slot (e.g. slot_00)
  --no-browser        Run headlessly without opening GUI window or browser
  --cli               Alias for headless CLI mode
${syncDoc}
  --help, -h          Show this help message`)
}

function isLoopbackHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function isWildcardBindHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase()
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '0:0:0:0:0:0:0:0'
}

function isCgnatIpv4(addr) {
  const parts = String(addr || '').split('.')
  if (parts.length !== 4) return false
  const a = Number.parseInt(parts[0], 10)
  const b = Number.parseInt(parts[1], 10)
  return a === 100 && b >= 64 && b <= 127
}

function findInterfaceNameForAddress(addr) {
  const target = String(addr || '').trim().toLowerCase()
  if (!target) return ''
  const ifaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (String(entry.address || '').trim().toLowerCase() === target) {
        return name
      }
    }
  }
  return ''
}

function collectLanUrls(port) {
  const urls = []
  const seen = new Set()
  const ifaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries || VIRTUAL_ADAPTER_PATTERN.test(name)) continue
    for (const entry of entries) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4
      if (!isIpv4 || entry.internal) continue
      const addr = entry.address.trim()
      if (
        !addr ||
        addr.startsWith('127.') ||
        addr.startsWith('169.254.') ||
        addr === '0.0.0.0' ||
        isCgnatIpv4(addr)
      ) {
        continue
      }
      const url = `http://${addr}:${port}`
      if (!seen.has(url)) {
        seen.add(url)
        urls.push({ url, interfaceName: name })
      }
    }
  }
  return urls
}

function scanSaveSlotsLocally(saveDir) {
  if (!saveDir || typeof saveDir !== 'string') return []
  const dirsToCheck = [path.join(saveDir, 'save'), saveDir]
  const slots = new Set()
  for (const dir of dirsToCheck) {
    try {
      if (!fs.existsSync(dir)) continue
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && /^slot_/i.test(entry.name)) {
          slots.add(entry.name)
        }
      }
      if (slots.size > 0) break
    } catch {
      // Ignore unreadable save dir
    }
  }
  return Array.from(slots).sort((a, b) => a.localeCompare(b))
}

function isAllowedExternalUrl(rawUrl, state) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false
  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') {
    return ALLOWED_EXTERNAL_HTTPS_HOSTS.has(parsed.hostname.toLowerCase())
  }
  if (parsed.protocol === 'http:') {
    if (state?.localUrl) {
      try {
        if (new URL(state.localUrl).origin === parsed.origin) return true
      } catch {
        // Ignore
      }
    }
    if (Array.isArray(state?.lanUrls)) {
      return state.lanUrls.some((item) => {
        try {
          return new URL(item.url).origin === parsed.origin
        } catch {
          return false
        }
      })
    }
  }
  return false
}

function probeTcpPort(host, port, timeoutMs = 200) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

function updateNx2SwitchFile(configPath, newLine) {
  const activeSwitchRe = /^\s*EDEN_NX2_DEBUG_SERVER\s*=\s*(.+?)\s*$/
  const outLines = []

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8')
    const existingLines = raw.split(/\r?\n/)
    let replaced = false
    for (const line of existingLines) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('#') && activeSwitchRe.test(line)) {
        if (!replaced) {
          outLines.push(newLine)
          replaced = true
        }
        continue
      }
      outLines.push(line)
    }
    if (!replaced) {
      if (outLines.length > 0 && outLines[outLines.length - 1] === '') {
        outLines.pop()
      }
      outLines.push(newLine)
    }
  } else {
    outLines.push('# Emulator NX2 switches (configured by Ocarina Atlas)')
    outLines.push('# Restart Lichii / Fritchii / Eden / CheezyEmu after editing.')
    outLines.push(newLine)
  }

  let content = outLines.join('\n')
  if (!content.endsWith('\n')) {
    content += '\n'
  }
  fs.writeFileSync(configPath, content, 'utf8')
}

function normalizePossibleWinePath(rawPath) {
  if (typeof rawPath !== 'string') return ''
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (/^[zZ]:[\\/]/.test(trimmed)) {
    return trimmed.slice(2).replace(/\\/g, '/')
  }
  return trimmed
}

function normalizeProcessName(rawName, allowedSet, isComm = false) {
  if (!rawName) return null
  const trimmed = String(rawName).trim()
  if (!trimmed) return null
  const base = trimmed.split(/[\\/]/).pop() ?? ''
  if (!base) return null

  let normalized = base.toLowerCase()
  while (/\.(exe|appimage|x86_64|app)$/i.test(normalized)) {
    normalized = normalized.replace(/\.(exe|appimage|x86_64|app)$/i, '')
  }
  if (allowedSet.has(normalized)) {
    return normalized
  }

  // Linux /proc/<pid>/comm truncates process names at 15 chars (e.g. "heylisten.appim", "relink-game.x86")
  if (isComm && base.length >= 15) {
    const dotIdx = normalized.indexOf('.')
    if (dotIdx > 0) {
      const prefix = normalized.slice(0, dotIdx)
      if (allowedSet.has(prefix)) {
        return prefix
      }
    }
  }
  return null
}

function isRelinkProcessName(name) {
  return name === 'relink' || name === 'relink-game'
}

function normalizeLanguage(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().split('.')[0].split('@')[0].replace(/_/g, '-')
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()

  const exact = SUPPORTED_LANGUAGES.find((code) => code.toLowerCase() === lower)
  if (exact) return exact

  const parts = lower.split('-')
  const base = parts[0]
  const region = parts[1] || ''
  if (base === 'zh') {
    if (region === 'tw' || region === 'hk' || region === 'mo' || region === 'hant') {
      return 'zh-TW'
    }
    return 'zh-CN'
  }
  const baseMatch = SUPPORTED_LANGUAGES.find((code) => code === base)
  return baseMatch || null
}

function detectDefaultLanguage() {
  try {
    const appLocale = typeof app?.getLocale === 'function' ? app.getLocale() : ''
    const fromApp = normalizeLanguage(appLocale)
    if (fromApp) return fromApp
  } catch {
    // Ignore if app.getLocale is unavailable
  }
  const envLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return normalizeLanguage(envLocale) || 'en'
}

function normalizeSavedSaveDirs(rawDirs, currentDir = '') {
  const result = []
  const seen = new Set()
  if (Array.isArray(rawDirs)) {
    for (const entry of rawDirs) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  const active = typeof currentDir === 'string' ? currentDir.trim() : ''
  if (active && !seen.has(active)) {
    result.push(active)
  }
  return result
}

function createSettingsStore({ getSettingsPath, getSaveSettingsPath }) {
  function readJsonFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return {}
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function loadSavedSettings() {
    return readJsonFile(getSettingsPath())
  }

  function saveSettings(settings) {
    try {
      const filePath = getSettingsPath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const existing = getSettingsPath() === getSaveSettingsPath() ? readJsonFile(filePath) : {}
      fs.writeFileSync(filePath, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  function loadSaveSettings() {
    return readJsonFile(getSaveSettingsPath())
  }

  function saveSaveSettings(settings) {
    try {
      const filePath = getSaveSettingsPath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const existing = readJsonFile(filePath)
      const customSaveDir =
        typeof settings.customSaveDir === 'string' ? settings.customSaveDir.trim() : ''
      const customSaveSlot =
        typeof settings.customSaveSlot === 'string' ? settings.customSaveSlot.trim() : ''
      const savedSaveDirs = normalizeSavedSaveDirs(settings.savedSaveDirs, customSaveDir)
      const merged = {
        ...existing,
        savedSaveDirs,
        customSaveDir,
        customSaveSlot,
      }
      fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  return {
    loadSavedSettings,
    saveSettings,
    loadSaveSettings,
    saveSaveSettings,
  }
}

function readAppVersion(baseDir, electronApp = app) {
  const candidates = [
    path.join(baseDir, 'package.json'),
    path.join(baseDir, '..', '..', 'package.json'),
  ]
  for (const pkgPath of candidates) {
    try {
      if (!fs.existsSync(pkgPath)) continue
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim()
      }
    } catch {
      // Try next
    }
  }
  return (electronApp && typeof electronApp.getVersion === 'function' && electronApp.getVersion()) || '2.3.0'
}

function resolveSharedUiFile(baseDir, filename) {
  const candidates = [
    path.join(baseDir, filename),
    path.join(baseDir, '..', 'desktop-electron', filename),
  ]
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

function terminateChild(child, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', done)
    try {
      child.kill('SIGTERM')
    } catch {
      done()
      return
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore
        }
      }
      done()
    }, timeoutMs)
    timer.unref()
  })
}

function fetchJsonHttp(url, timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

function postJsonHttp(url, body, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let payload = '{}'
    try {
      payload = JSON.stringify(body ?? {})
    } catch {
      resolve(null)
      return
    }
    const parsed = new URL(url)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const raw = Buffer.concat(chunks).toString('utf8')
              resolve(raw ? JSON.parse(raw) : { ok: true })
            } catch {
              resolve({ ok: true })
            }
          } else {
            resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.write(payload)
    req.end()
  })
}

function isAllowedGitHubUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false
  try {
    const parsed = new URL(rawUrl.trim())
    return parsed.protocol === 'https:' && ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

function fetchHttpsJson(
  url,
  headers = {},
  timeoutMs = 6000,
  redirectsLeft = MAX_REDIRECTS,
  userAgent = 'Ocarina-Atlas-Desktop-Launcher',
) {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubUrl(url)) {
      reject(new Error('Blocked untrusted update host'))
      return
    }
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/vnd.github+json',
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          let nextUrl
          try {
            nextUrl = new URL(res.headers.location, url).toString()
          } catch {
            reject(new Error('Invalid redirect URL'))
            return
          }
          if (!isAllowedGitHubUrl(nextUrl)) {
            reject(new Error('Blocked untrusted redirect host'))
            return
          }
          fetchHttpsJson(nextUrl, headers, timeoutMs, redirectsLeft - 1, userAgent).then(resolve, reject)
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error('Invalid JSON from GitHub'))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.on('error', reject)
  })
}

function fetchHttpsText(
  url,
  timeoutMs = 15000,
  redirectsLeft = MAX_REDIRECTS,
  userAgent = 'Ocarina-Atlas-Desktop-Launcher',
) {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubUrl(url)) {
      reject(new Error('Blocked untrusted update host'))
      return
    }
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/plain, application/octet-stream, */*',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          let nextUrl
          try {
            nextUrl = new URL(res.headers.location, url).toString()
          } catch {
            reject(new Error('Invalid redirect URL'))
            return
          }
          if (!isAllowedGitHubUrl(nextUrl)) {
            reject(new Error('Blocked untrusted redirect host'))
            return
          }
          fetchHttpsText(nextUrl, timeoutMs, redirectsLeft - 1, userAgent).then(resolve, reject)
          return
        }
        const chunks = []
        let totalLen = 0
        res.on('data', (c) => {
          totalLen += c.length
          if (totalLen <= 65536) {
            chunks.push(c)
          }
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub download HTTP ${res.statusCode}`))
            return
          }
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Checksum download timed out'))
    })
    req.on('error', reject)
  })
}

function parseSha256Digest(rawText) {
  const text = String(rawText ?? '').trim()
  const match = /\b([0-9a-fA-F]{64})\b/.exec(text)
  if (!match) {
    throw new Error('Invalid or missing 64-character hex SHA-256 digest in .sha256 sidecar')
  }
  return match[1].toLowerCase()
}

function downloadHttpsToFileWithSha256(
  url,
  destPath,
  onProgress,
  timeoutMs = 120000,
  redirectsLeft = MAX_REDIRECTS,
  userAgent = 'Ocarina-Atlas-Desktop-Launcher',
) {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubUrl(url)) {
      reject(new Error('Blocked untrusted update host'))
      return
    }
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/octet-stream, */*',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
          }
          let nextUrl
          try {
            nextUrl = new URL(res.headers.location, url).toString()
          } catch {
            reject(new Error('Invalid redirect URL'))
            return
          }
          if (!isAllowedGitHubUrl(nextUrl)) {
            reject(new Error('Blocked untrusted redirect host'))
            return
          }
          downloadHttpsToFileWithSha256(
            nextUrl,
            destPath,
            onProgress,
            timeoutMs,
            redirectsLeft - 1,
            userAgent,
          ).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Download HTTP ${res.statusCode}`))
          return
        }

        const totalBytes = Number.parseInt(String(res.headers['content-length'] || '0'), 10) || 0
        let downloadedBytes = 0
        let lastProgressAt = 0
        const hash = crypto.createHash('sha256')
        const outStream = fs.createWriteStream(destPath, { mode: 0o600 })
        let settled = false

        const fail = (err) => {
          if (settled) return
          settled = true
          res.destroy()
          outStream.destroy()
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
          } catch {
            // Ignore cleanup error
          }
          reject(err)
        }

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length
          hash.update(chunk)
          const now = Date.now()
          if (typeof onProgress === 'function' && (now - lastProgressAt >= 80 || downloadedBytes === totalBytes)) {
            lastProgressAt = now
            const percent =
              totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null
            onProgress({
              stage: 'downloading',
              downloadedBytes,
              totalBytes,
              percent,
            })
          }
        })

        res.on('error', fail)
        outStream.on('error', fail)

        outStream.on('finish', () => {
          outStream.close((closeErr) => {
            if (closeErr) {
              fail(closeErr)
              return
            }
            if (settled) return
            settled = true
            resolve({
              actualSha256: hash.digest('hex').toLowerCase(),
              downloadedBytes,
              totalBytes,
            })
          })
        })

        res.pipe(outStream)
      },
    )

    req.on('timeout', () => {
      req.destroy()
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      } catch {
        // Ignore
      }
      reject(new Error('Download timed out'))
    })
    req.on('error', (err) => {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      } catch {
        // Ignore
      }
      reject(err)
    })
  })
}

function parseSemver(raw) {
  const clean = String(raw ?? '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(clean)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    pre: match[4] || '',
  }
}

function isNewerSemver(candidateRaw, currentRaw) {
  const a = parseSemver(candidateRaw)
  const b = parseSemver(currentRaw)
  if (!a || !b) return false
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  if (a.patch !== b.patch) return a.patch > b.patch
  // A stable release (no prerelease tag) is newer than a prerelease of the same X.Y.Z
  if (b.pre && !a.pre) return true
  return false
}

async function checkForUpdates(currentVersion, options = {}) {
  const userAgent = options.userAgent || 'Ocarina-Atlas-Desktop-Launcher'
  const assetCandidates = Array.isArray(options.assetCandidates) ? options.assetCandidates : []
  const allowInPlaceAppImage = Boolean(options.allowInPlaceAppImage)

  try {
    const release = await fetchHttpsJson(OFFICIAL_RELEASES_API_URL, {}, 6000, MAX_REDIRECTS, userAgent)
    if (!release || release.draft || release.prerelease) {
      return {
        status: 'up-to-date',
        currentVersion,
        latestVersion: currentVersion,
        releaseUrl: OFFICIAL_REPO_URL + '/releases/latest',
        appImageDownloadUrl: '',
        macDownloadUrl: '',
        sha256DownloadUrl: '',
        canSelfUpdate: false,
      }
    }
    const htmlUrl = String(release.html_url || '')
    if (!htmlUrl.startsWith(OFFICIAL_REPO_URL + '/') || !isAllowedGitHubUrl(htmlUrl)) {
      return { status: 'error', currentVersion, error: 'Untrusted release URL', canSelfUpdate: false }
    }

    const assets = Array.isArray(release.assets) ? release.assets : []
    const assetMap = new Map()
    for (const asset of assets) {
      if (!asset || typeof asset !== 'object') continue
      const assetName = String(asset.name || '').trim()
      const downloadUrl = String(asset.browser_download_url || '').trim()
      if (!assetName || !isAllowedGitHubUrl(downloadUrl)) continue
      assetMap.set(assetName, downloadUrl)
    }

    let matchedDownloadUrl = ''
    let matchedShaUrl = ''
    for (const candidateName of assetCandidates) {
      const url = assetMap.get(candidateName)
      if (url) {
        matchedDownloadUrl = url
        matchedShaUrl = assetMap.get(`${candidateName}.sha256`) || ''
        break
      }
    }

    const latestTag = String(release.tag_name || '').trim()
    const hasUpdate = isNewerSemver(latestTag, currentVersion)
    const canSelfUpdate = Boolean(
      allowInPlaceAppImage && process.env.APPIMAGE && matchedDownloadUrl && matchedShaUrl,
    )

    return {
      status: hasUpdate ? 'update-available' : 'up-to-date',
      currentVersion,
      latestVersion: latestTag.replace(/^v/i, '') || currentVersion,
      releaseUrl: htmlUrl,
      publishedAt: release.published_at || '',
      appImageDownloadUrl: allowInPlaceAppImage ? matchedDownloadUrl : '',
      macDownloadUrl: allowInPlaceAppImage ? '' : matchedDownloadUrl,
      sha256DownloadUrl: matchedShaUrl,
      canSelfUpdate,
    }
  } catch (err) {
    return {
      status: 'error',
      currentVersion,
      error: err instanceof Error ? err.message : String(err),
      canSelfUpdate: false,
    }
  }
}

async function createLauncherApp(adapter) {
  let cliOpts
  try {
    cliOpts = parseArgs(getCliArgs(), process.env)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    console.error('Run with --help for usage.')
    process.exit(2)
  }

  if (cliOpts.help) {
    printHelp(adapter.platformName || process.platform, adapter.syncHelpLines || [])
    process.exit(0)
  }

  if (cliOpts.setupSync) {
    const res = await adapter.setupSync(cliOpts.lichiiHost, cliOpts.lichiiPort)
    if (res.updated.length === 0) {
      console.log('No existing Lichii, Fritchii, Eden, or CheezyEmu profile directory was found.')
      console.log(`Create the profile directory or add manually: ${res.line}`)
    } else {
      console.log(`Configured ${res.line} in:`)
      for (const p of res.updated) console.log(`  - ${p}`)
    }
    process.exit(0)
  }

  const paths = adapter.resolveRuntimePaths()
  if (!fs.existsSync(paths.serverEntry)) {
    console.error(`FATAL: Missing standalone server at ${paths.serverEntry}`)
    process.exit(1)
  }
  if (
    !fs.existsSync(path.join(paths.distDir, 'client')) ||
    !fs.existsSync(path.join(paths.distDir, 'server', 'server.js'))
  ) {
    console.error(`FATAL: Missing built dist/client or dist/server under ${paths.distDir}`)
    process.exit(1)
  }

  const settingsStore = createSettingsStore({
    getSettingsPath: adapter.getSettingsPath,
    getSaveSettingsPath: adapter.getSaveSettingsPath,
  })

  const appVersion = readAppVersion(adapter.baseDir, app)
  const saved = settingsStore.loadSavedSettings()
  const savedSave = settingsStore.loadSaveSettings()
  const hasDisplay = typeof adapter.hasDisplay === 'function' ? adapter.hasDisplay() : true
  const isHeadless = cliOpts.noBrowser || cliOpts.cli || !hasDisplay

  const initialCustomSaveDir =
    cliOpts.saveDir || (typeof savedSave.customSaveDir === 'string' ? savedSave.customSaveDir.trim() : '')
  const initialLanguage =
    normalizeLanguage(saved.language) || normalizeLanguage(savedSave.language) || detectDefaultLanguage()

  const state = {
    platform: process.platform,
    version: appVersion,
    headless: isHeadless,
    lifecycle: 'stopped', // 'stopped' | 'starting' | 'running'
    port:
      cliOpts.port !== DEFAULT_PORT || process.env.PORT
        ? cliOpts.port
        : parsePort(saved.port, DEFAULT_PORT, true),
    host: cliOpts.lanExplicit
      ? cliOpts.host
      : typeof saved.host === 'string' && saved.host.trim()
        ? saved.host.trim()
        : cliOpts.host,
    lichiiHost:
      process.env.LICHII_HOST || cliOpts.lichiiHost !== DEFAULT_LICHII_HOST
        ? sanitizeLichiiHost(cliOpts.lichiiHost) || DEFAULT_LICHII_HOST
        : sanitizeLichiiHost(saved.lichiiHost) || cliOpts.lichiiHost,
    lichiiPort:
      process.env.LICHII_PORT || cliOpts.lichiiPort !== DEFAULT_LICHII_PORT
        ? cliOpts.lichiiPort
        : parsePort(saved.lichiiPort, cliOpts.lichiiPort, false),
    autoOpen: typeof saved.autoOpen === 'boolean' ? saved.autoOpen : true,
    autoStart: typeof saved.autoStart === 'boolean' ? saved.autoStart : true,
    language: initialLanguage,
    savedSaveDirs: normalizeSavedSaveDirs(savedSave.savedSaveDirs, initialCustomSaveDir),
    customSaveDir: initialCustomSaveDir,
    customSaveSlot:
      cliOpts.saveSlot || (typeof savedSave.customSaveSlot === 'string' ? savedSave.customSaveSlot.trim() : ''),
    localUrl: '',
    boundPort: cliOpts.port,
    lanUrls: [],
    runtime: null,
    telemetry: null,
    availableSaveSlots: [],
    ptraceScope: typeof adapter.getPtraceScope === 'function' ? adapter.getPtraceScope() : null,
    bridgePermissionError: null,
    syncMessage: '',
    syncStatus: 'idle', // 'idle' | 'ok' | 'warn'
    updateInfo: null,
    logs: [],
  }

  let mainWindow = null
  let serverChild = null
  let bridgeChild = null
  let bridgePollInFlight = false
  let shuttingDown = false
  let bridgeTimer = null
  let telemetryTimer = null
  let lastAutoSyncedSaveDir = ''

  function emitLog(level, msg) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`
    state.logs.push({ level, line })
    if (state.logs.length > MAX_LOG_LINES) {
      state.logs.splice(0, state.logs.length - MAX_LOG_LINES)
    }
    if (isHeadless) {
      if (level === 'error') console.error(msg)
      else console.log(msg)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher:log', { level, line })
    }
  }

  if (typeof adapter.setLogSink === 'function') {
    adapter.setLogSink(emitLog)
  }

  function getPublicState() {
    return {
      platform: state.platform,
      version: state.version,
      lifecycle: state.lifecycle,
      port: state.port,
      host: state.host,
      lichiiHost: state.lichiiHost,
      lichiiPort: state.lichiiPort,
      autoOpen: state.autoOpen,
      autoStart: state.autoStart,
      language: state.language,
      savedSaveDirs: state.savedSaveDirs,
      customSaveDir: state.customSaveDir,
      customSaveSlot: state.customSaveSlot,
      localUrl: state.localUrl,
      boundPort: state.boundPort,
      lanUrls: state.lanUrls,
      runtime: state.runtime,
      telemetry: state.telemetry,
      availableSaveSlots: state.availableSaveSlots,
      ptraceScope: state.ptraceScope,
      bridgePermissionError: state.bridgePermissionError,
      syncMessage: state.syncMessage,
      syncStatus: state.syncStatus,
      updateInfo: state.updateInfo,
    }
  }

  function computeLanUrls() {
    const effectivePort = state.boundPort || state.port
    if (isWildcardBindHost(state.host)) {
      return collectLanUrls(effectivePort)
    }
    if (!isLoopbackHost(state.host)) {
      const trimmedHost = String(state.host || '').trim()
      if (trimmedHost) {
        const formattedHost =
          trimmedHost.includes(':') && !trimmedHost.startsWith('[') ? `[${trimmedHost}]` : trimmedHost
        const ifaceName = findInterfaceNameForAddress(trimmedHost) || 'bound'
        return [{ url: `http://${formattedHost}:${effectivePort}`, interfaceName: ifaceName }]
      }
    }
    return []
  }

  function refreshLocalAvailableSaveSlots() {
    if (state.lifecycle === 'running' && Array.isArray(state.telemetry?.availableSaveSlots)) {
      state.availableSaveSlots = state.telemetry.availableSaveSlots
      return
    }
    const targetDir = state.customSaveDir || state.runtime?.saveDir || ''
    state.availableSaveSlots = scanSaveSlotsLocally(targetDir)
  }

  function pushState() {
    state.lanUrls = computeLanUrls()
    refreshLocalAvailableSaveSlots()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher:state', getPublicState())
    }
  }

  function persistSettings() {
    settingsStore.saveSettings({
      port: state.port,
      host: state.host,
      lichiiHost: state.lichiiHost,
      lichiiPort: state.lichiiPort,
      autoOpen: state.autoOpen,
      autoStart: state.autoStart,
      language: state.language,
    })
  }

  function persistSaveSettings() {
    state.savedSaveDirs = normalizeSavedSaveDirs(state.savedSaveDirs, state.customSaveDir)
    settingsStore.saveSaveSettings({
      savedSaveDirs: state.savedSaveDirs,
      customSaveDir: state.customSaveDir,
      customSaveSlot: state.customSaveSlot,
    })
  }

  async function postSaveSlotUpdate() {
    if (state.lifecycle !== 'running' || !state.boundPort) return null
    const payload = {
      saveDir: state.customSaveDir || null,
      slot: state.customSaveSlot || null,
    }
    const res = await postJsonHttp(`http://127.0.0.1:${state.boundPort}/api/saves/slot`, payload, 1500)
    if (res && res.ok !== false) {
      emitLog(
        'info',
        `[saves] Updated save source: dir=${state.customSaveDir || 'auto-detect'}, slot=${state.customSaveSlot || 'auto'}`,
      )
      void pollTelemetry()
    } else {
      emitLog('warn', '[saves] Failed to push save folder/slot update to running server.')
    }
    return res
  }

  async function manageBridge() {
    if (shuttingDown || bridgePollInFlight) return
    bridgePollInFlight = true
    try {
      if (typeof adapter.getPtraceScope === 'function') {
        state.ptraceScope = adapter.getPtraceScope()
      }
      state.runtime = await adapter.detectRuntime(paths)
      if (typeof adapter.getBridgePermissionError === 'function') {
        state.bridgePermissionError = adapter.getBridgePermissionError()
      }

      const target =
        state.runtime && state.runtime.kind === 'recomp' && state.runtime.pid ? state.runtime : null

      // Dynamically update running server's save folder when a recomp/NX2Saria launches after server start
      if (state.lifecycle === 'running' && state.boundPort && !state.customSaveDir) {
        let nextAutoSaveDir = ''
        if (state.runtime?.kind === 'recomp') {
          nextAutoSaveDir =
            process.env.LONGSHOT_SAVE_DIR?.trim() ||
            state.runtime.saveDir ||
            (await adapter.detectRecompSaveDir(state.runtime)) ||
            ''
        } else if (state.runtime && NX2SARIA_PROCESS_NAMES.has(state.runtime.name)) {
          nextAutoSaveDir =
            process.env.NX2SARIA_SAVE_DIR?.trim() || (await adapter.detectNx2SariaProfileDir()) || ''
        }

        if (nextAutoSaveDir && nextAutoSaveDir !== lastAutoSyncedSaveDir) {
          lastAutoSyncedSaveDir = nextAutoSaveDir
          const res = await postJsonHttp(
            `http://127.0.0.1:${state.boundPort}/api/saves/slot`,
            { saveDir: nextAutoSaveDir, slot: state.customSaveSlot || null },
            1500,
          )
          if (res && res.ok !== false) {
            emitLog('info', `[saves] Auto-synced save source for ${state.runtime.displayName}: ${nextAutoSaveDir}`)
            void pollTelemetry()
          }
        } else if (!state.runtime && lastAutoSyncedSaveDir) {
          lastAutoSyncedSaveDir = ''
          await postJsonHttp(
            `http://127.0.0.1:${state.boundPort}/api/saves/slot`,
            { saveDir: null, slot: state.customSaveSlot || null },
            1500,
          )
        }
      }

      if (
        target &&
        target.needsBridge !== false &&
        isLoopbackHost(state.lichiiHost) &&
        paths.bridgeBin &&
        fs.existsSync(paths.bridgeBin) &&
        (!bridgeChild || bridgeChild.exitCode !== null || bridgeChild.signalCode !== null)
      ) {
        const portBusy = await probeTcpPort('127.0.0.1', state.lichiiPort, 150)
        if (!portBusy) {
          if (typeof adapter.beforeSpawnBridge === 'function') {
            adapter.beforeSpawnBridge(target, state, emitLog)
          }

          const child = spawn(paths.bridgeBin, ['--port', String(state.lichiiPort), '--once'], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          bridgeChild = child
          emitLog(
            'info',
            `[bridge] Started read-only Longshot RPC bridge on 127.0.0.1:${state.lichiiPort} (PID ${target.pid}, ${target.name}).`,
          )

          const forward = (stream, lvl) => {
            if (!stream) return
            readline.createInterface({ input: stream }).on('line', (line) => {
              if (line.trim()) {
                emitLog(lvl, `[bridge] ${line}`)
                if (typeof adapter.onBridgeOutput === 'function') {
                  adapter.onBridgeOutput(line, state)
                }
              }
            })
          }
          forward(child.stdout, 'info')
          forward(child.stderr, 'error')

          child.once('exit', (code, signal) => {
            if (bridgeChild === child) bridgeChild = null
            if (!shuttingDown && code !== 0 && code !== null) {
              emitLog('warn', `[bridge] Exited with code ${code}${signal ? ` (${signal})` : ''}.`)
            }
          })
          child.once('error', (err) => {
            if (bridgeChild === child) bridgeChild = null
            emitLog('error', `[bridge] Failed to start: ${err.message}`)
          })
        }
      }
    } finally {
      bridgePollInFlight = false
      pushState()
    }
  }

  async function pollTelemetry() {
    if (shuttingDown) return
    if (state.lifecycle !== 'running' || !state.boundPort) {
      if (state.telemetry !== null) {
        state.telemetry = null
        pushState()
      }
      return
    }
    const data = await fetchJsonHttp(`http://127.0.0.1:${state.boundPort}/api/lichii/state`, 600)
    state.telemetry = data
    pushState()
  }

  async function startServer() {
    if (serverChild || state.lifecycle !== 'stopped') return
    state.lifecycle = 'starting'
    state.localUrl = ''
    state.boundPort = state.port
    pushState()

    const runningTarget = await adapter.scanRunningRecompProcess(paths)
    const detectedSaveDir =
      process.env.LONGSHOT_SAVE_DIR?.trim() || (await adapter.detectRecompSaveDir(runningTarget))
    const nx2sariaSaveDir =
      process.env.NX2SARIA_SAVE_DIR?.trim() || (await adapter.detectNx2SariaProfileDir())
    lastAutoSyncedSaveDir = detectedSaveDir || nx2sariaSaveDir || ''

    const serverEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: state.host,
      PORT: String(state.port),
      LICHII_HOST: state.lichiiHost,
      LICHII_PORT: String(state.lichiiPort),
      APP_DIST_DIR: paths.distDir,
    }
    if (detectedSaveDir && !serverEnv.LONGSHOT_SAVE_DIR) {
      serverEnv.LONGSHOT_SAVE_DIR = detectedSaveDir
    }
    if (nx2sariaSaveDir && !serverEnv.NX2SARIA_SAVE_DIR) {
      serverEnv.NX2SARIA_SAVE_DIR = nx2sariaSaveDir
    }
    if (state.customSaveDir) {
      serverEnv.CUSTOM_SAVE_DIR = state.customSaveDir
    } else {
      delete serverEnv.CUSTOM_SAVE_DIR
    }
    if (state.customSaveSlot) {
      serverEnv.CUSTOM_SAVE_SLOT = state.customSaveSlot
    } else {
      delete serverEnv.CUSTOM_SAVE_SLOT
    }

    emitLog('info', `[server] Starting Ocarina Atlas on ${state.host}:${state.port}...`)
    const child = spawn(
      process.execPath,
      [paths.serverEntry, '--host', state.host, '--port', String(state.port)],
      {
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    serverChild = child

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      if (trimmed.startsWith('READY ')) {
        const url = trimmed.slice('READY '.length).trim()
        let boundPort = state.port
        try {
          boundPort = Number.parseInt(new URL(url).port, 10) || state.port
        } catch {
          // Ignore
        }
        state.lifecycle = 'running'
        state.localUrl = url
        state.boundPort = boundPort
        emitLog('info', `[server] Ready at ${url}`)
        pushState()

        if (!isHeadless && state.autoOpen) {
          void shell.openExternal(url)
        }
        return
      }

      if (trimmed.startsWith('LAN ')) return
      emitLog('info', `[server] ${trimmed}`)
    })

    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) emitLog('error', `[server:err] ${line}`)
    })

    child.once('error', (err) => {
      emitLog('error', `[server] Failed to spawn: ${err.message}`)
      if (serverChild === child) serverChild = null
      state.lifecycle = 'stopped'
      state.localUrl = ''
      state.telemetry = null
      pushState()
    })

    child.once('exit', (code, signal) => {
      if (serverChild === child) serverChild = null
      const wasRunning = state.lifecycle !== 'stopped'
      state.lifecycle = 'stopped'
      state.localUrl = ''
      state.telemetry = null
      lastAutoSyncedSaveDir = ''
      if (!shuttingDown && wasRunning) {
        emitLog(
          code === 0 ? 'info' : 'warn',
          `[server] Stopped (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}).`,
        )
      }
      pushState()
      if (isHeadless && !shuttingDown) {
        void shutdown(signal ? `server-${signal}` : `server-exit-${code ?? 0}`, code ?? 0)
      }
    })
  }

  async function stopServer() {
    if (!serverChild) {
      state.lifecycle = 'stopped'
      state.localUrl = ''
      state.telemetry = null
      pushState()
      return
    }
    const child = serverChild
    emitLog('info', '[server] Stopping Ocarina Atlas...')
    await terminateChild(child, 2500)
    if (serverChild === child) serverChild = null
    state.lifecycle = 'stopped'
    state.localUrl = ''
    state.telemetry = null
    lastAutoSyncedSaveDir = ''
    pushState()
  }

  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return
    shuttingDown = true
    if (bridgeTimer) clearInterval(bridgeTimer)
    if (telemetryTimer) clearInterval(telemetryTimer)
    if (isHeadless) {
      console.log(`Shutting down Ocarina Atlas (${reason})...`)
    }
    await Promise.all([
      terminateChild(serverChild, 2500),
      terminateChild(bridgeChild, 1500),
    ])
    serverChild = null
    bridgeChild = null
    if (isHeadless) {
      process.exit(exitCode)
    } else {
      app.exit(exitCode)
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
  process.on('SIGHUP', () => void shutdown('SIGHUP', 0))

  // Headless mode: never initialize a BrowserWindow
  if (isHeadless) {
    await manageBridge()
    bridgeTimer = setInterval(() => void manageBridge(), 2000)
    bridgeTimer.unref()
    await startServer()
    return
  }

  // GUI mode via Electron BrowserWindow
  await app.whenReady()

  const preloadPath = resolveSharedUiFile(adapter.baseDir, 'preload.cjs')
  const htmlPath = resolveSharedUiFile(adapter.baseDir, 'index.html')

  function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus()
      return
    }
    mainWindow = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT_COMPACT,
      minWidth: 520,
      minHeight: 460,
      backgroundColor: '#13100C',
      title: 'Ocarina Atlas',
      autoHideMenuBar: true,
      icon: paths.iconPath || undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    if (process.platform !== 'darwin') {
      mainWindow.setMenuBarVisibility(false)
    }

    const expectedPageUrl = pathToFileURL(htmlPath).href
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (typeof targetUrl === 'string' && targetUrl.split('#')[0] === expectedPageUrl) {
        return
      }
      event.preventDefault()
    })

    void mainWindow.loadFile(htmlPath)

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }

  ipcMain.handle('launcher:get-state', () => ({
    ...getPublicState(),
    logs: state.logs,
  }))

  ipcMain.handle('launcher:start-server', () => {
    void startServer()
    return { ok: true }
  })

  ipcMain.handle('launcher:stop-server', async () => {
    await stopServer()
    return { ok: true }
  })

  ipcMain.handle('launcher:open-map', async () => {
    if (state.localUrl) {
      await shell.openExternal(state.localUrl)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('launcher:open-external', async (_ev, url) => {
    if (isAllowedExternalUrl(url, state)) {
      await shell.openExternal(url.trim())
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('launcher:copy-text', (_ev, text) => {
    if (typeof text === 'string' && text.length > 0) {
      clipboard.writeText(text)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('launcher:setup-sync', async () => {
    const safeHost = sanitizeLichiiHost(state.lichiiHost) || DEFAULT_LICHII_HOST
    const res = await adapter.setupSync(safeHost, state.lichiiPort)
    if (res.updated.length > 0) {
      state.syncStatus = 'ok'
      state.syncMessage = `Configured ${res.line} in ${res.updated.length} profile(s). Restart emulator to apply.`
      emitLog('info', `[sync] Configured ${res.line} in ${res.updated.join(', ')}`)
    } else {
      state.syncStatus = 'warn'
      state.syncMessage = `No Lichii/Fritchii/Eden/CheezyEmu profile found. Add ${res.line} to nx2_switches.txt.`
      emitLog('warn', `[sync] No existing profile directory found for ${res.line}`)
    }
    pushState()
    return res
  })

  ipcMain.handle('launcher:refresh-lan', () => {
    pushState()
    return { lanUrls: state.lanUrls }
  })

  ipcMain.handle('launcher:toggle-lan', async (_ev, enabled) => {
    const nextHost = enabled ? DEFAULT_HOST : '127.0.0.1'
    if (state.host === nextHost) return getPublicState()
    const wasRunning = state.lifecycle !== 'stopped'
    state.host = nextHost
    persistSettings()
    if (wasRunning) {
      await stopServer()
      void startServer()
    } else {
      pushState()
    }
    return getPublicState()
  })

  ipcMain.handle('launcher:browse-save-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Select Custom Save Folder',
      defaultPath: state.customSaveDir || undefined,
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true, state: getPublicState() }
    }
    const selected = String(result.filePaths[0] || '').trim()
    if (!selected) {
      return { canceled: true, state: getPublicState() }
    }
    state.savedSaveDirs = normalizeSavedSaveDirs(state.savedSaveDirs, selected)
    state.customSaveDir = selected
    persistSaveSettings()
    pushState()
    if (state.lifecycle === 'running' && state.boundPort) {
      await postSaveSlotUpdate()
    }
    return { canceled: false, saveDir: selected, state: getPublicState() }
  })

  ipcMain.handle('launcher:remove-save-dir', async (_ev, dir) => {
    const target = typeof dir === 'string' && dir.trim() ? dir.trim() : state.customSaveDir
    if (!target) {
      return getPublicState()
    }
    state.savedSaveDirs = state.savedSaveDirs.filter((entry) => entry !== target)
    if (state.customSaveDir === target) {
      state.customSaveDir = ''
    }
    persistSaveSettings()
    pushState()
    if (state.lifecycle === 'running' && state.boundPort) {
      await postSaveSlotUpdate()
    }
    return getPublicState()
  })

  ipcMain.handle('launcher:update-settings', async (_ev, patch) => {
    if (!patch || typeof patch !== 'object') return getPublicState()
    if (state.lifecycle === 'stopped') {
      if (patch.port !== undefined) {
        const p = parsePort(patch.port, state.port, false)
        state.port = p
        state.boundPort = p
      }
      if (typeof patch.host === 'string' && patch.host.trim()) {
        state.host = patch.host.trim()
      }
      if (typeof patch.lichiiHost === 'string') {
        const sanitizedHost = sanitizeLichiiHost(patch.lichiiHost)
        if (sanitizedHost) {
          state.lichiiHost = sanitizedHost
        }
      }
      if (patch.lichiiPort !== undefined) {
        state.lichiiPort = parsePort(patch.lichiiPort, state.lichiiPort, false)
      }
    }
    if (typeof patch.autoOpen === 'boolean') state.autoOpen = patch.autoOpen
    if (typeof patch.autoStart === 'boolean') state.autoStart = patch.autoStart
    if (typeof patch.language === 'string') {
      const nextLang = normalizeLanguage(patch.language)
      if (nextLang) state.language = nextLang
    }
    let saveSettingsChanged = false
    if (typeof patch.customSaveDir === 'string') {
      const nextDir = patch.customSaveDir.trim()
      if (nextDir && !state.savedSaveDirs.includes(nextDir)) {
        state.savedSaveDirs = [...state.savedSaveDirs, nextDir]
        saveSettingsChanged = true
      }
      if (nextDir !== state.customSaveDir) {
        state.customSaveDir = nextDir
        saveSettingsChanged = true
      }
    }
    if (typeof patch.customSaveSlot === 'string') {
      const nextSlot = patch.customSaveSlot.trim()
      if (nextSlot !== state.customSaveSlot) {
        state.customSaveSlot = nextSlot
        saveSettingsChanged = true
      }
    }
    persistSettings()
    if (saveSettingsChanged) {
      persistSaveSettings()
      if (state.lifecycle === 'running' && state.boundPort) {
        await postSaveSlotUpdate()
      }
    }
    pushState()
    return getPublicState()
  })

  ipcMain.handle('launcher:set-language', (_ev, lang) => {
    const nextLang = normalizeLanguage(lang)
    if (nextLang && nextLang !== state.language) {
      state.language = nextLang
      persistSettings()
      pushState()
    }
    return getPublicState()
  })

  ipcMain.handle('launcher:reset-rpc-defaults', () => {
    if (state.lifecycle === 'stopped') {
      state.lichiiHost = DEFAULT_LICHII_HOST
      state.lichiiPort = DEFAULT_LICHII_PORT
      persistSettings()
      pushState()
    }
    return getPublicState()
  })

  ipcMain.handle('launcher:check-updates', async () => {
    const info = await checkForUpdates(state.version, adapter.updateOptions)
    state.updateInfo = info
    pushState()
    return info
  })

  let updateInFlight = false
  function emitUpdateProgress(progress) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launcher:update-progress', progress)
    }
  }

  async function handleApplyUpdate(_ev, opts = {}) {
    if (typeof adapter.applyUpdate !== 'function') {
      const releaseUrl = state.updateInfo?.releaseUrl || OFFICIAL_REPO_URL + '/releases/latest'
      await shell.openExternal(releaseUrl)
      return { ok: true, openedReleaseUrl: releaseUrl }
    }
    if (updateInFlight) {
      return { ok: false, error: 'An update is already in progress.' }
    }
    updateInFlight = true
    try {
      if (!state.updateInfo || !state.updateInfo.appImageDownloadUrl || !state.updateInfo.sha256DownloadUrl) {
        state.updateInfo = await checkForUpdates(state.version, adapter.updateOptions)
        pushState()
      }
      return await adapter.applyUpdate({
        state,
        opts,
        emitLog,
        emitUpdateProgress,
        prepareForRelaunch: async () => {
          await Promise.all([
            terminateChild(serverChild, 2000),
            terminateChild(bridgeChild, 1000),
          ])
          serverChild = null
          bridgeChild = null
        },
        shutdown,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      emitLog('error', `[update] ${errorMsg}`)
      emitUpdateProgress({ stage: 'error', error: errorMsg })
      return { ok: false, error: errorMsg }
    } finally {
      updateInFlight = false
    }
  }

  ipcMain.handle('apply-update', handleApplyUpdate)
  ipcMain.handle('launcher:apply-update', handleApplyUpdate)

  ipcMain.handle('launcher:clear-logs', () => {
    state.logs = []
    return { ok: true }
  })

  ipcMain.handle('launcher:set-drawer-open', (_ev, open) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [w] = mainWindow.getSize()
      const targetHeight = open ? WINDOW_HEIGHT_EXPANDED : WINDOW_HEIGHT_COMPACT
      mainWindow.setSize(w, targetHeight, true)
    }
    return { ok: true }
  })

  createWindow()

  await manageBridge()
  bridgeTimer = setInterval(() => void manageBridge(), 2000)
  telemetryTimer = setInterval(() => void pollTelemetry(), 1200)

  if (state.autoStart) {
    void startServer()
  }

  // Silent background update check
  void checkForUpdates(state.version, adapter.updateOptions).then((info) => {
    state.updateInfo = info
    pushState()
  })

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (adapter.quitOnWindowAllClosed !== false) {
      void shutdown('window-all-closed', 0)
    }
  })

  app.on('before-quit', (ev) => {
    if (!shuttingDown) {
      ev.preventDefault()
      void shutdown('before-quit', 0)
    }
  })
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_LICHII_HOST,
  DEFAULT_LICHII_PORT,
  MAX_REDIRECTS,
  OFFICIAL_REPO_URL,
  OFFICIAL_RELEASES_API_URL,
  RECOMP_PROCESS_NAMES,
  DIRECT_HOST_VA_PROCESS_NAMES,
  NX2SARIA_PROCESS_NAMES,
  EMULATOR_PROCESS_NAMES,
  RUNTIME_DISPLAY_NAMES,
  SYNC_PROFILE_NAMES,
  SYNC_PROCESS_NAMES,
  MANDATORY_CONFIG_PROFILES,
  parsePort,
  sanitizeLichiiHost,
  getCliArgs,
  parseArgs,
  isLoopbackHost,
  isWildcardBindHost,
  isCgnatIpv4,
  collectLanUrls,
  scanSaveSlotsLocally,
  isAllowedExternalUrl,
  probeTcpPort,
  updateNx2SwitchFile,
  normalizePossibleWinePath,
  normalizeProcessName,
  isRelinkProcessName,
  normalizeLanguage,
  detectDefaultLanguage,
  normalizeSavedSaveDirs,
  createSettingsStore,
  isAllowedGitHubUrl,
  fetchHttpsJson,
  fetchHttpsText,
  parseSha256Digest,
  downloadHttpsToFileWithSha256,
  parseSemver,
  isNewerSemver,
  checkForUpdates,
  createLauncherApp,
}
