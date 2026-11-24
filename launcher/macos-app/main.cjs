'use strict'

const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function loadSharedCore() {
  try {
    return require('./shared-core.cjs')
  } catch {
    return require('../desktop-electron/shared-core.cjs')
  }
}

const core = loadSharedCore()

const MACOS_USER_AGENT = 'Ocarina-Atlas-macOS-Launcher'
const TASK_FOR_PID_ERR_RE = /(?:task_for_pid|KERN_PROTECTION_FAILURE|KERN_FAILURE|EPERM|permission\s+denied)/i

let lastBridgePermissionError = null
let cachedPaths = null

function getMacAppSupportDir() {
  return path.join(os.homedir(), 'Library', 'Application Support')
}

function getSettingsPath() {
  return path.join(getMacAppSupportDir(), 'ocarina-atlas', 'settings.json')
}

function resolveRuntimePaths() {
  if (cachedPaths) return cachedPaths
  const resourcesDir = process.resourcesPath || __dirname
  const repoRoot = path.resolve(__dirname, '..', '..')

  const serverCandidates = [
    path.join(resourcesDir, 'app', 'standalone-server.mjs'),
    path.join(__dirname, 'app', 'standalone-server.mjs'),
    path.join(repoRoot, 'dist', 'standalone-server.mjs'),
  ]
  const serverEntry = serverCandidates.find((p) => fs.existsSync(p)) || serverCandidates[0]

  const distCandidates = [
    path.join(resourcesDir, 'app', 'dist'),
    path.join(__dirname, 'app', 'dist'),
    path.join(repoRoot, 'dist'),
  ]
  const distDir = distCandidates.find((p) => fs.existsSync(p)) || distCandidates[0]

  const bridgeCandidates = [
    path.join(resourcesDir, 'bin', 'longshot-rpc-bridge'),
    path.join(__dirname, 'bin', 'longshot-rpc-bridge'),
    path.join(repoRoot, 'dist-macos-app', 'bin', 'longshot-rpc-bridge'),
  ]
  const bridgeBin = bridgeCandidates.find((p) => fs.existsSync(p)) || bridgeCandidates[0]

  const iconCandidates = [
    path.join(resourcesDir, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(repoRoot, 'public', 'icons', 'icon-512.png'),
  ]
  const iconPath = iconCandidates.find((p) => fs.existsSync(p)) || null

  cachedPaths = { serverEntry, distDir, bridgeBin, iconPath }
  return cachedPaths
}

function getPsArgs() {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : ''
  return uid ? ['-U', uid, '-o', 'pid=,args='] : ['-axo', 'pid=,args=']
}

function parsePsOutput(stdout) {
  const rows = []
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    const args = (match[2] || '').trim()
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !args) continue
    rows.push({ pid, args })
  }
  return rows
}

function tokenizeCommandArgs(argsStr) {
  const tokens = []
  let current = ''
  let quote = null
  for (let i = 0; i < argsStr.length; i += 1) {
    const ch = argsStr[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < argsStr.length) {
        current += argsStr[i + 1]
        i += 1
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

function extractProcessCandidates(argsStr) {
  const candidates = []
  const seen = new Set()
  const add = (val) => {
    const cleaned = String(val || '').trim().replace(/^["']|["']$/g, '')
    if (!cleaned || seen.has(cleaned)) return
    seen.add(cleaned)
    candidates.push(cleaned)
  }

  // 1. Quote-aware tokens
  for (const tok of tokenizeCommandArgs(argsStr)) {
    add(tok)
  }

  // 2. Unquoted .app/Contents/MacOS/<bin> paths (handles spaces like "/Applications/Project ReLink.app/...")
  const appRe = /(?:^|\s|["'])((?:\/[^\r\n]*?)\.app)\/Contents\/MacOS\/([^\s/"']+)/g
  let m
  while ((m = appRe.exec(argsStr)) !== null) {
    add(`${m[1]}/Contents/MacOS/${m[2]}`)
  }

  // 3. Unquoted Wine/Windows .exe paths with spaces (e.g. "Z:\Users\foo\Project ReLink\relink.exe")
  const exeRe = /(?:^|\s|["'])([a-zA-Z]:[\\/][^\r\n]*?\.exe)(?=\s|$|["'])/gi
  while ((m = exeRe.exec(argsStr)) !== null) {
    add(m[1])
  }

  // 4. Flag path values like --user "/path/with spaces" or --user=/path/with spaces
  const flagRe = /(?:^|\s)--(?:user|profile)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\/[^\r\n]*?))(?=\s+--|\s*$)/g
  while ((m = flagRe.exec(argsStr)) !== null) {
    add(m[1] || m[2] || m[3])
  }

  return candidates
}

function listMacProcessesSync() {
  if (process.platform !== 'darwin') return []
  try {
    const out = execFileSync('ps', getPsArgs(), {
      encoding: 'utf8',
      timeout: 1500,
    })
    return parsePsOutput(out)
  } catch {
    return []
  }
}

function listMacProcessesAsync() {
  if (process.platform !== 'darwin') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('ps', getPsArgs(), { encoding: 'utf8', timeout: 1500 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([])
        return
      }
      resolve(parsePsOutput(stdout))
    })
  })
}

function collectWinePrefixDirs(procs) {
  const home = os.homedir()
  const appSupport = getMacAppSupportDir()
  const prefixes = new Set()
  const addPrefix = (dir) => {
    if (!dir) return
    try {
      const resolved = path.resolve(dir)
      if (fs.existsSync(path.join(resolved, 'drive_c'))) {
        prefixes.add(resolved)
      }
    } catch {
      // Ignore
    }
  }

  if (process.env.WINEPREFIX) addPrefix(process.env.WINEPREFIX.trim())
  addPrefix(path.join(home, '.wine'))

  for (const bottleBase of [
    path.join(appSupport, 'CrossOver', 'Bottles'),
    path.join(home, 'Library', 'Containers', 'com.isaacmarovitz.Whisky', 'Bottles'),
  ]) {
    try {
      if (!fs.existsSync(bottleBase)) continue
      for (const entry of fs.readdirSync(bottleBase, { withFileTypes: true })) {
        if (entry.isDirectory()) addPrefix(path.join(bottleBase, entry.name))
      }
    } catch {
      // Ignore
    }
  }

  for (const proc of procs) {
    const m = /(?:^|\s|["'])((?:\/[^\r\n]*?)\/drive_c)(?:\/|$)/i.exec(proc.args)
    if (m) addPrefix(path.dirname(m[1]))
  }

  return Array.from(prefixes)
}

function isSymlinkPath(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

function setupSync(lichiiHost = core.DEFAULT_LICHII_HOST, lichiiPort = core.DEFAULT_LICHII_PORT) {
  const home = os.homedir()
  const appSupport = getMacAppSupportDir()
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
  const target = `${lichiiHost}:${lichiiPort}`
  const newLine = `EDEN_NX2_DEBUG_SERVER=${target}`

  const candidates = []
  const candidateSet = new Set()
  const addCandidate = (cfgPath) => {
    if (!cfgPath || candidateSet.has(cfgPath)) return
    candidateSet.add(cfgPath)
    candidates.push(cfgPath)
  }

  for (const name of core.SYNC_PROFILE_NAMES) {
    addCandidate(path.join(appSupport, name, 'nx2_switches.txt'))
    addCandidate(path.join(xdgConfigHome, name, 'nx2_switches.txt'))
  }

  const forcedTargets = new Set([
    path.join(appSupport, 'lichii', 'nx2_switches.txt'),
    path.join(appSupport, 'fritchii', 'nx2_switches.txt'),
  ])

  const procs = listMacProcessesSync()

  // Scan Wine prefixes: <prefix>/drive_c/users/*/AppData/Roaming/*/nx2_switches.txt
  for (const prefix of collectWinePrefixDirs(procs)) {
    const usersDir = path.join(prefix, 'drive_c', 'users')
    try {
      if (!fs.existsSync(usersDir)) continue
      for (const userEntry of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (!userEntry.isDirectory()) continue
        const roamingDir = path.join(usersDir, userEntry.name, 'AppData', 'Roaming')
        if (!fs.existsSync(roamingDir)) continue
        for (const name of core.SYNC_PROFILE_NAMES) {
          addCandidate(path.join(roamingDir, name, 'nx2_switches.txt'))
        }
        for (const appEntry of fs.readdirSync(roamingDir, { withFileTypes: true })) {
          if (!appEntry.isDirectory()) continue
          const existingSwitch = path.join(roamingDir, appEntry.name, 'nx2_switches.txt')
          if (fs.existsSync(existingSwitch)) {
            addCandidate(existingSwitch)
          }
        }
      }
    } catch {
      // Ignore unreadable Wine prefix
    }
  }

  for (const proc of procs) {
    const tokens = extractProcessCandidates(proc.args)
    let matchedName = null
    let appBundleDir = ''
    let wineExeDir = ''

    for (const tok of tokens) {
      if (!tok || tok.startsWith('-')) continue
      const candidate = core.normalizeProcessName(tok, core.SYNC_PROCESS_NAMES, false)
      if (candidate && !matchedName) {
        matchedName = candidate
      }
      const appIdx = tok.indexOf('.app/Contents/')
      if (appIdx > 0 && !appBundleDir) {
        appBundleDir = tok.slice(0, appIdx + 4)
      }
      if (/^[zZ]:[\\/]/.test(tok) && !wineExeDir) {
        wineExeDir = path.dirname(core.normalizePossibleWinePath(tok))
      }
    }

    if (!matchedName) continue

    const portableDirs = []
    if (appBundleDir) {
      portableDirs.push(path.join(appBundleDir, 'Contents', 'MacOS'))
      portableDirs.push(path.dirname(appBundleDir))
    }
    if (wineExeDir) {
      portableDirs.push(wineExeDir)
    }

    for (const dir of portableDirs) {
      if (!dir) continue
      const directSwitch = path.join(dir, 'nx2_switches.txt')
      const portableUser = path.join(dir, 'user')
      if (fs.existsSync(directSwitch) || fs.existsSync(portableUser)) {
        addCandidate(directSwitch)
        forcedTargets.add(directSwitch)
        if (fs.existsSync(portableUser)) {
          const userSwitch = path.join(portableUser, 'nx2_switches.txt')
          addCandidate(userSwitch)
          forcedTargets.add(userSwitch)
        }
      }
    }
  }

  const updated = []
  for (const cfgPath of candidates) {
    const profileDir = path.dirname(cfgPath)
    const profileName = path.basename(profileDir).toLowerCase()
    const shouldCreateDir =
      forcedTargets.has(cfgPath) ||
      (path.dirname(profileDir) === appSupport && core.MANDATORY_CONFIG_PROFILES.has(profileName))
    try {
      if (shouldCreateDir && !fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true })
      }
      if (fs.existsSync(profileDir)) {
        if (isSymlinkPath(profileDir) || isSymlinkPath(cfgPath)) continue
        core.updateNx2SwitchFile(cfgPath, newLine)
        updated.push(cfgPath)
      }
    } catch {
      // Ignore unwritable candidate paths
    }
  }

  return { updated, checked: candidates, line: newLine, target }
}

function runBridgeDetect(bridgeBin) {
  if (!bridgeBin || !fs.existsSync(bridgeBin)) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    execFile(bridgeBin, ['--detect'], { encoding: 'utf8', timeout: 1500 }, (err, stdout, stderr) => {
      const errText = String(stderr || err?.message || '').trim()
      if (err) {
        if (TASK_FOR_PID_ERR_RE.test(errText)) {
          lastBridgePermissionError = errText.split(/\r?\n/)[0] || 'task_for_pid permission denied'
        }
        resolve(null)
        return
      }

      let pid = 0
      let emulator = ''
      let saveDir = ''
      for (const rawLine of String(stdout || '').split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line.startsWith('PID=')) {
          pid = Number.parseInt(line.slice(4), 10) || 0
        } else if (line.startsWith('EMULATOR=')) {
          emulator = line.slice('EMULATOR='.length).trim().toLowerCase()
        } else if (line.startsWith('SAVE_DIR=')) {
          saveDir = line.slice('SAVE_DIR='.length).trim()
        }
      }

      if (pid > 0 && emulator) {
        lastBridgePermissionError = null
        resolve({ pid, name: emulator, saveDir: saveDir || null })
      } else {
        if (TASK_FOR_PID_ERR_RE.test(errText)) {
          lastBridgePermissionError = errText.split(/\r?\n/)[0] || 'task_for_pid permission denied'
        } else {
          lastBridgePermissionError = null
        }
        resolve(null)
      }
    })
  })
}

async function scanRunningRecompProcess(paths) {
  const resolved = paths || resolveRuntimePaths()
  return runBridgeDetect(resolved.bridgeBin)
}

async function detectMacRuntime(paths) {
  const recomp = await scanRunningRecompProcess(paths)
  if (recomp) {
    return {
      kind: 'recomp',
      name: recomp.name,
      displayName: core.RUNTIME_DISPLAY_NAMES[recomp.name] || recomp.name,
      pid: recomp.pid,
      saveDir: recomp.saveDir || detectRecompSaveDir(recomp),
      needsBridge: true,
    }
  }

  const procs = await listMacProcessesAsync()
  let fallbackRecomp = null
  for (const proc of procs) {
    const tokens = extractProcessCandidates(proc.args)
    for (const tok of tokens) {
      if (!tok || tok.startsWith('-')) continue
      const matchedEmu = core.normalizeProcessName(tok, core.EMULATOR_PROCESS_NAMES, false)
      if (matchedEmu && !(matchedEmu === 'ocarina' && lastBridgePermissionError)) {
        return {
          kind: 'emulator',
          name: matchedEmu,
          displayName: core.RUNTIME_DISPLAY_NAMES[matchedEmu] || matchedEmu,
          pid: proc.pid,
          saveDir: null,
          needsBridge: false,
        }
      }
      if (!fallbackRecomp) {
        const matchedRecomp = core.normalizeProcessName(tok, core.RECOMP_PROCESS_NAMES, false)
        if (matchedRecomp) {
          fallbackRecomp = {
            kind: 'recomp',
            name: matchedRecomp,
            displayName: core.RUNTIME_DISPLAY_NAMES[matchedRecomp] || matchedRecomp,
            pid: proc.pid,
            saveDir: detectRecompSaveDir({ name: matchedRecomp, pid: proc.pid }),
            needsBridge: !lastBridgePermissionError,
          }
        }
      }
    }
  }

  return fallbackRecomp
}

function detectRecompSaveDir(runningTarget) {
  if (!runningTarget || !runningTarget.name) {
    return null
  }
  if (runningTarget.saveDir && fs.existsSync(runningTarget.saveDir)) {
    return runningTarget.saveDir
  }

  const home = os.homedir()
  const appSupport = getMacAppSupportDir()
  const name = String(runningTarget.name).toLowerCase()

  if (core.isRelinkProcessName(name)) {
    const relinkCandidates = [
      path.join(appSupport, 'relink'),
      path.join(home, 'Games', 'ProjectReLink', 'user'),
      path.join(home, 'Games', 'ProjectReLink', 'game', 'user'),
      path.join(home, 'Games', 'ReLink', 'user'),
      path.join(home, 'Games', 'ReLink', 'game', 'user'),
    ]
    return relinkCandidates.find((dir) => fs.existsSync(dir)) || null
  }

  if (name === 'rekarina') {
    const rekarinaCandidates = [
      path.join(appSupport, 'Rekarina', 'game', 'profile'),
      path.join(appSupport, 'Rekarina', 'profile'),
      path.join(home, 'Games', 'Rekarina', 'game', 'profile'),
      path.join(home, 'Games', 'Rekarina', 'profile'),
    ]
    return (
      rekarinaCandidates.find((dir) => fs.existsSync(path.join(dir, 'save'))) ||
      rekarinaCandidates.find((dir) => fs.existsSync(dir)) ||
      null
    )
  }

  const byNameCandidates = {
    longshot: [
      path.join(appSupport, 'longshot', 'user'),
      path.join(appSupport, 'longshot'),
      path.join(home, 'Games', 'Longshot', 'user'),
    ],
    hookshot: [
      path.join(appSupport, 'hookshot', 'user'),
      path.join(home, 'Games', 'Hookshot', 'user'),
    ],
    heylisten: [
      path.join(appSupport, 'heylisten', 'user'),
      path.join(home, 'Games', 'HeyListen', 'user'),
    ],
    triforce: [
      path.join(appSupport, 'triforce', 'user'),
      path.join(home, 'Games', 'Triforce', 'user'),
    ],
    nx2navi: [
      path.join(appSupport, 'nx2navi', 'profile'),
      path.join(appSupport, 'ocarina', 'profile'),
      path.join(home, 'Games', 'OOT-PC', 'profile'),
    ],
    ocarina: [
      path.join(appSupport, 'ocarina', 'profile'),
      path.join(appSupport, 'nx2navi', 'profile'),
      path.join(home, 'Games', 'OOT-PC', 'profile'),
    ],
  }
  const specific = byNameCandidates[name] || []
  return specific.find((dir) => fs.existsSync(dir)) || null
}

function detectNx2SariaProfileDir() {
  const home = os.homedir()
  const appSupport = getMacAppSupportDir()
  const dynamicCandidates = []
  const seen = new Set()
  const addProfile = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    dynamicCandidates.push(dir)
  }

  for (const proc of listMacProcessesSync()) {
    const tokens = extractProcessCandidates(proc.args)
    let isNx2Saria = false
    for (const tok of tokens) {
      if (!tok || tok.startsWith('-')) continue
      if (core.normalizeProcessName(tok, core.NX2SARIA_PROCESS_NAMES, false)) {
        isNx2Saria = true
        break
      }
    }
    if (!isNx2Saria) continue

    for (const tok of tokens) {
      if (!tok || tok.startsWith('-')) continue
      const normalized = core.normalizePossibleWinePath(tok)
      if (!normalized.includes('/') && !normalized.includes('\\')) continue
      const appIdx = normalized.indexOf('.app/Contents/')
      if (appIdx > 0) {
        const appBundleDir = normalized.slice(0, appIdx + 4)
        addProfile(path.join(appBundleDir, 'Contents', 'MacOS', 'profile'))
        addProfile(path.join(appBundleDir, 'Contents', 'Resources', 'profile'))
        addProfile(path.join(path.dirname(appBundleDir), 'profile'))
      }
      const exeDir = path.dirname(normalized)
      addProfile(path.join(exeDir, 'profile'))
      addProfile(path.join(path.dirname(exeDir), 'profile'))
      if (path.basename(normalized).toLowerCase() === 'profile' || fs.existsSync(path.join(normalized, 'save'))) {
        addProfile(normalized)
      }
    }
  }

  const candidates = [
    ...dynamicCandidates,
    path.join(appSupport, 'nx2saria', 'profile'),
    path.join(appSupport, 'ocarina', 'profile'),
    path.join(home, 'Games', 'NX2Saria', 'profile'),
  ]
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'save'))) || null
}

function getMacUpdateAssetCandidates() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return [
    `OcarinaAtlas-MacOS-${arch}.dmg`,
    `OcarinaAtlas-MacOS-${arch}.zip`,
    'OcarinaAtlas-MacOS.dmg',
    'OcarinaAtlas-MacOS.zip',
  ]
}

void core
  .createLauncherApp({
    baseDir: __dirname,
    platformName: 'macOS',
    syncHelpLines: [
      '  --setup-sync        Write EDEN_NX2_DEBUG_SERVER=<host>:<port> to',
      '                      ~/Library/Application Support/{lichii,fritchii,eden,cheezyemu}/nx2_switches.txt and exit',
    ],
    getSettingsPath,
    getSaveSettingsPath: getSettingsPath,
    resolveRuntimePaths,
    setupSync,
    detectRuntime: detectMacRuntime,
    scanRunningRecompProcess,
    detectRecompSaveDir,
    detectNx2SariaProfileDir,
    getPtraceScope: () => null,
    getBridgePermissionError: () => lastBridgePermissionError,
    onBridgeOutput: (line, state) => {
      if (TASK_FOR_PID_ERR_RE.test(line)) {
        lastBridgePermissionError = line.trim()
        state.bridgePermissionError = lastBridgePermissionError
      }
    },
    hasDisplay: () => true,
    quitOnWindowAllClosed: false,
    updateOptions: {
      userAgent: MACOS_USER_AGENT,
      assetCandidates: getMacUpdateAssetCandidates(),
      allowInPlaceAppImage: false,
    },
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
