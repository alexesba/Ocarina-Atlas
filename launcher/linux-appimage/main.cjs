'use strict'

const { app } = require('electron')
const { spawn } = require('node:child_process')
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

const LINUX_USER_AGENT = 'Ocarina-Atlas-Linux-Launcher'
const LINUX_APPIMAGE_ASSET_NAME = 'OcarinaAtlas-Linux-x64.AppImage'

let bridgeLogSink = null
let lastPtraceProbeWarnPid = 0
let lastPtraceProbeWarnAt = 0
let warnedPtrace = false

function readCmdlineTokens(pid) {
  try {
    const rawCmd = fs.readFileSync(`/proc/${pid}/cmdline`)
    return rawCmd
      .toString('utf8')
      .split('\0')
      .map((t) => t.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function setupSync(lichiiHost = core.DEFAULT_LICHII_HOST, lichiiPort = core.DEFAULT_LICHII_PORT) {
  const home = os.homedir()
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
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
    addCandidate(path.join(configHome, name, 'nx2_switches.txt'))
  }
  for (const name of core.SYNC_PROFILE_NAMES) {
    addCandidate(path.join(dataHome, name, 'nx2_switches.txt'))
  }

  const forcedTargets = new Set([
    path.join(configHome, 'lichii', 'nx2_switches.txt'),
    path.join(configHome, 'fritchii', 'nx2_switches.txt'),
  ])

  if (process.platform === 'linux' && fs.existsSync('/proc')) {
    try {
      const entries = fs.readdirSync('/proc', { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
        const pid = Number.parseInt(entry.name, 10)
        if (pid === process.pid) continue

        let matchedName = null
        try {
          const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8')
          matchedName = core.normalizeProcessName(comm, core.SYNC_PROCESS_NAMES, true)
        } catch {
          // Ignore
        }

        const cmdTokens = readCmdlineTokens(pid)
        let wineExeToken = ''
        for (const tok of cmdTokens) {
          if (tok.startsWith('-')) continue
          const candidate = core.normalizeProcessName(tok, core.SYNC_PROCESS_NAMES, false)
          if (candidate) {
            if (!matchedName) matchedName = candidate
            if (/^[zZ]:[\\/]/.test(tok)) wineExeToken = tok
            break
          }
        }

        let exePath = ''
        try {
          exePath = fs.readlinkSync(`/proc/${pid}/exe`)
          if (!matchedName) {
            matchedName = core.normalizeProcessName(exePath, core.SYNC_PROCESS_NAMES, false)
          }
        } catch {
          // Ignore
        }

        if (!matchedName) continue

        const exeDirs = []
        if (exePath) exeDirs.push(path.dirname(exePath))
        if (wineExeToken) exeDirs.push(path.dirname(core.normalizePossibleWinePath(wineExeToken)))

        for (const exeDir of exeDirs) {
          if (!exeDir) continue
          const directSwitchPath = path.join(exeDir, 'nx2_switches.txt')
          const portableUserDir = path.join(exeDir, 'user')
          if (fs.existsSync(directSwitchPath) || fs.existsSync(portableUserDir)) {
            addCandidate(directSwitchPath)
            forcedTargets.add(directSwitchPath)
            if (fs.existsSync(portableUserDir)) {
              const userSwitchPath = path.join(portableUserDir, 'nx2_switches.txt')
              addCandidate(userSwitchPath)
              forcedTargets.add(userSwitchPath)
            }
          }
        }
      }
    } catch {
      // Ignore /proc scan errors
    }
  }

  const updated = []
  for (const cfgPath of candidates) {
    const profileDir = path.dirname(cfgPath)
    const profileName = path.basename(profileDir).toLowerCase()
    const shouldCreateDir =
      forcedTargets.has(cfgPath) ||
      (path.dirname(profileDir) === configHome && core.MANDATORY_CONFIG_PROFILES.has(profileName))
    try {
      if (shouldCreateDir && !fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true })
      }
      if (fs.existsSync(profileDir)) {
        core.updateNx2SwitchFile(cfgPath, newLine)
        updated.push(cfgPath)
      }
    } catch {
      // Ignore unwritable candidate paths
    }
  }

  return { updated, checked: candidates, line: newLine, target }
}

function resolveLongshotSaveDir() {
  const home = os.homedir()
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
  const xdgLongshot = path.join(dataHome, 'longshot')
  const xdgLongshotUser = path.join(xdgLongshot, 'user')

  if (fs.existsSync(path.join(xdgLongshotUser, 'save'))) return xdgLongshotUser
  if (fs.existsSync(path.join(xdgLongshot, 'save'))) return xdgLongshot

  const gamesLongshotUser = path.join(home, 'Games', 'Longshot', 'user')
  if (fs.existsSync(path.join(gamesLongshotUser, 'save'))) return gamesLongshotUser
  if (fs.existsSync(xdgLongshotUser)) return xdgLongshotUser
  if (fs.existsSync(xdgLongshot)) return xdgLongshot
  if (fs.existsSync(gamesLongshotUser)) return gamesLongshotUser
  return null
}

// Native Linux Project ReLink moves <game folder>/user to $XDG_DATA_HOME/relink (save/<uid>/slot_*) at its first start
function resolveRelinkLinuxSaveDir() {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  const xdgRelink = path.join(dataHome, 'relink')
  return fs.existsSync(path.join(xdgRelink, 'save')) ? xdgRelink : null
}

function resolveUserSaveDirFromExe(exePath, emulatorName = null) {
  if (!exePath) return null
  const normalizedExe = core.normalizePossibleWinePath(exePath)
  if (!normalizedExe) return null
  const exeDir = path.dirname(normalizedExe)
  const leaf = path.basename(exeDir).toLowerCase()
  const gameRoot = leaf === 'bin' ? path.dirname(exeDir) : exeDir
  if (!gameRoot) return null

  const userDir = path.join(gameRoot, 'user')
  if (fs.existsSync(path.join(userDir, 'save'))) return userDir

  const profileDir = path.join(gameRoot, 'profile')
  if (fs.existsSync(path.join(profileDir, 'save'))) return profileDir

  if (core.isRelinkProcessName(emulatorName)) {
    return resolveRelinkLinuxSaveDir() || (fs.existsSync(userDir) ? userDir : null)
  }

  if (emulatorName === 'rekarina') {
    return fs.existsSync(profileDir) ? profileDir : null
  }

  let parentDir = gameRoot
  for (let depth = 0; depth < 3; depth += 1) {
    const nextParent = path.dirname(parentDir)
    if (!nextParent || nextParent === parentDir) break
    parentDir = nextParent

    const portableUser = path.join(parentDir, 'LongshotLauncher-data', 'user')
    if (fs.existsSync(portableUser)) return portableUser
    if (path.basename(parentDir).toLowerCase() === 'longshotlauncher-data') {
      const directPortableUser = path.join(parentDir, 'user')
      if (fs.existsSync(directPortableUser)) return directPortableUser
    }
  }

  return resolveLongshotSaveDir() || (fs.existsSync(userDir) ? userDir : null)
}

function readYamaPtraceScope() {
  try {
    const raw = fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    return Number.parseInt(raw, 10)
  } catch {
    return null
  }
}

function warnPtraceProbeBlocked(pid, procName, errCode) {
  const now = Date.now()
  if (pid === lastPtraceProbeWarnPid && now - lastPtraceProbeWarnAt < 30000) return
  lastPtraceProbeWarnPid = pid
  lastPtraceProbeWarnAt = now
  const ptraceScope = readYamaPtraceScope()
  const scopeSuffix = ptraceScope !== null ? ` (kernel.yama.ptrace_scope=${ptraceScope})` : ''
  const msg = `[bridge] Cannot read /proc/${pid}/mem for ${procName} (${errCode})${scopeSuffix}. Check kernel.yama.ptrace_scope (e.g. sudo sysctl -w kernel.yama.ptrace_scope=0).`
  if (typeof bridgeLogSink === 'function') bridgeLogSink('warn', msg)
  else console.warn(msg)
}

function scanRunningRecompProcess() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return null
  let entries
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number.parseInt(entry.name, 10)
    if (pid === process.pid) continue

    let matchedName = null
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8')
      matchedName = core.normalizeProcessName(comm, core.RECOMP_PROCESS_NAMES, true)
    } catch {
      // Ignore
    }

    const cmdTokens = readCmdlineTokens(pid)
    const cmdArgv0 = cmdTokens[0] || ''
    let matchedCmdExe = ''
    let cliUserDir = ''
    for (let i = 0; i < cmdTokens.length; i += 1) {
      const tok = cmdTokens[i]
      if (tok === '--user' && i + 1 < cmdTokens.length) {
        const candidateDir = core.normalizePossibleWinePath(cmdTokens[i + 1])
        if (candidateDir && fs.existsSync(candidateDir)) cliUserDir = candidateDir
        i += 1
        continue
      }
      if (tok.startsWith('--user=')) {
        const candidateDir = core.normalizePossibleWinePath(tok.slice('--user='.length))
        if (candidateDir && fs.existsSync(candidateDir)) cliUserDir = candidateDir
        continue
      }
      if (tok.startsWith('-')) continue
      const candidate = core.normalizeProcessName(tok, core.RECOMP_PROCESS_NAMES, false)
      if (candidate) {
        if (!matchedName) matchedName = candidate
        if (!matchedCmdExe) matchedCmdExe = tok
      }
    }

    let exePath = ''
    try {
      exePath = fs.readlinkSync(`/proc/${pid}/exe`)
      if (!matchedName) {
        matchedName = core.normalizeProcessName(exePath, core.RECOMP_PROCESS_NAMES, false)
      }
    } catch {
      // Ignore
    }

    if (!matchedName) continue

    let probeAddr = null
    try {
      const maps = fs.readFileSync(`/proc/${pid}/maps`, 'utf8')
      const isDirectHostVa = core.DIRECT_HOST_VA_PROCESS_NAMES.has(matchedName)
      for (const line of maps.split('\n')) {
        const match = /^([0-9a-f]+)-([0-9a-f]+)\s+([r-])/i.exec(line)
        if (!match || match[3] !== 'r') continue
        const start = BigInt(`0x${match[1]}`)
        const end = BigInt(`0x${match[2]}`)
        if (isDirectHostVa) {
          if (end > 0x7000000000n && start < 0x8000000000n) {
            const ovStart = start > 0x7000000000n ? start : 0x7000000000n
            const ovEnd = end < 0x8000000000n ? end : 0x8000000000n
            if (ovEnd - ovStart >= 8n) {
              probeAddr = ovStart
              break
            }
          }
        } else if (start <= 0x100080000000n && end >= 0x100080000008n) {
          probeAddr = 0x100080000000n
          break
        }
      }
      if (probeAddr === null) continue
    } catch {
      continue
    }

    let memFd = null
    try {
      memFd = fs.openSync(`/proc/${pid}/mem`, 'r')
      const probeBuf = Buffer.alloc(8)
      const bytesRead = fs.readSync(memFd, probeBuf, 0, 8, BigInt(probeAddr))
      if (bytesRead < 8) continue
    } catch (err) {
      const errCode = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : ''
      if (errCode === 'EACCES' || errCode === 'EPERM') {
        warnPtraceProbeBlocked(pid, matchedName, errCode)
      }
      continue
    } finally {
      if (memFd !== null) {
        try {
          fs.closeSync(memFd)
        } catch {
          // Ignore
        }
      }
    }

    let saveDir = cliUserDir || null
    if (!saveDir && matchedCmdExe && /^[zZ]:[\\/]/.test(matchedCmdExe)) {
      saveDir = resolveUserSaveDirFromExe(matchedCmdExe, matchedName)
    }
    if (!saveDir && /^[zZ]:[\\/]/.test(cmdArgv0)) {
      saveDir = resolveUserSaveDirFromExe(cmdArgv0, matchedName)
    }
    if (!saveDir) {
      saveDir = resolveUserSaveDirFromExe(exePath, matchedName)
    }

    return { pid, name: matchedName, saveDir }
  }

  return null
}

function detectRecompSaveDir(runningTarget) {
  if (runningTarget?.saveDir && fs.existsSync(runningTarget.saveDir)) {
    return runningTarget.saveDir
  }

  const home = os.homedir()
  if (core.isRelinkProcessName(runningTarget?.name)) {
    const relinkSaveDir = resolveRelinkLinuxSaveDir()
    if (relinkSaveDir) return relinkSaveDir
    const relinkCandidates = [
      path.join(home, 'Games', 'ProjectReLink', 'user'),
      path.join(home, 'Games', 'ProjectReLink', 'game', 'user'),
      path.join(home, 'Games', 'ReLink', 'user'),
      path.join(home, 'Games', 'ReLink', 'game', 'user'),
    ]
    return relinkCandidates.find((dir) => fs.existsSync(dir)) || null
  }

  if (runningTarget?.name === 'rekarina') {
    const rekarinaCandidates = [
      path.join(home, 'Games', 'Rekarina', 'game', 'profile'),
      path.join(home, 'Games', 'Rekarina', 'profile'),
    ]
    return (
      rekarinaCandidates.find((dir) => fs.existsSync(path.join(dir, 'save'))) ||
      rekarinaCandidates.find((dir) => fs.existsSync(dir)) ||
      null
    )
  }

  const longshotSaveDir = resolveLongshotSaveDir()
  if (longshotSaveDir) return longshotSaveDir

  const candidates = [
    path.join(home, 'Games', 'Longshot', 'user'),
    path.join(home, 'Games', 'Hookshot', 'user'),
    path.join(home, 'Games', 'HeyListen', 'user'),
    path.join(home, 'Games', 'ProjectReLink', 'user'),
    path.join(home, 'Games', 'ProjectReLink', 'game', 'user'),
    path.join(home, 'Games', 'ReLink', 'user'),
    path.join(home, 'Games', 'ReLink', 'game', 'user'),
    path.join(home, 'Games', 'Triforce', 'user'),
    path.join(home, 'Games', 'Rekarina', 'game', 'profile'),
    path.join(home, 'Games', 'Rekarina', 'profile'),
  ]
  const relinkSaveDir = resolveRelinkLinuxSaveDir()
  if (relinkSaveDir) candidates.push(relinkSaveDir)
  return candidates.find((dir) => fs.existsSync(dir)) || null
}

function detectNx2SariaProfileDir() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return null
  let entries
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const comm = fs.readFileSync(`/proc/${entry.name}/comm`, 'utf8').trim().toLowerCase()
      if (!core.NX2SARIA_PROCESS_NAMES.has(comm)) continue
      const exeDir = path.dirname(fs.readlinkSync(`/proc/${entry.name}/exe`))
      const environ = fs.readFileSync(`/proc/${entry.name}/environ`, 'utf8').split('\0')
      const profileVar = environ.find((kv) => kv.startsWith('NX2SARIA_PROFILE_DIR='))
      const profileSetting = profileVar?.slice('NX2SARIA_PROFILE_DIR='.length)
      const profileDir = profileSetting ? path.resolve(exeDir, profileSetting) : path.join(exeDir, 'profile')
      if (fs.existsSync(path.join(profileDir, 'save'))) {
        return profileDir
      }
    } catch {
      // Ignore
    }
  }
  return null
}

function detectLinuxRuntime() {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return null
  const recomp = scanRunningRecompProcess()
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

  let entries
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number.parseInt(entry.name, 10)
    if (pid === process.pid) continue

    let matchedName = null
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8')
      matchedName = core.normalizeProcessName(comm, core.EMULATOR_PROCESS_NAMES, true)
    } catch {
      // Ignore
    }

    if (!matchedName) {
      for (const tok of readCmdlineTokens(pid)) {
        if (tok.startsWith('-')) continue
        matchedName = core.normalizeProcessName(tok, core.EMULATOR_PROCESS_NAMES, false)
        if (matchedName) break
      }
    }

    if (!matchedName) {
      try {
        const exePath = fs.readlinkSync(`/proc/${pid}/exe`)
        matchedName = core.normalizeProcessName(exePath, core.EMULATOR_PROCESS_NAMES, false)
      } catch {
        // Ignore
      }
    }

    if (matchedName) {
      return {
        kind: 'emulator',
        name: matchedName,
        displayName: core.RUNTIME_DISPLAY_NAMES[matchedName] || matchedName,
        pid,
        saveDir: null,
        needsBridge: false,
      }
    }
  }

  return null
}

function resolveRuntimePaths() {
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
    path.join(repoRoot, 'release', 'OcarinaAtlas-Linux-x64', 'runtime', 'longshot-rpc-bridge'),
  ]
  const bridgeBin = bridgeCandidates.find((p) => fs.existsSync(p)) || bridgeCandidates[0]

  const iconCandidates = [
    path.join(resourcesDir, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(repoRoot, 'public', 'icons', 'icon-512.png'),
  ]
  const iconPath = iconCandidates.find((p) => fs.existsSync(p)) || null

  return { serverEntry, distDir, bridgeBin, iconPath }
}

function getConfigDir() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  return path.join(configHome, 'ocarina-atlas')
}

async function applyAppImageUpdate({ state, opts, emitLog, emitUpdateProgress, prepareForRelaunch, shutdown }) {
  const appImagePath = typeof process.env.APPIMAGE === 'string' ? process.env.APPIMAGE.trim() : ''
  if (!appImagePath) {
    throw new Error('In-place update requires running from a packaged Linux AppImage (APPIMAGE is unset).')
  }
  if (!fs.existsSync(appImagePath) || !fs.statSync(appImagePath).isFile()) {
    throw new Error(`Current AppImage file was not found on disk: ${appImagePath}`)
  }
  try {
    fs.accessSync(appImagePath, fs.constants.W_OK)
    fs.accessSync(path.dirname(appImagePath), fs.constants.W_OK)
  } catch {
    throw new Error(`Current AppImage location is not writable: ${appImagePath}`)
  }

  const updateInfo = state.updateInfo
  const appImageDownloadUrl = String(updateInfo?.appImageDownloadUrl || '').trim()
  const sha256DownloadUrl = String(updateInfo?.sha256DownloadUrl || '').trim()
  if (!core.isAllowedGitHubUrl(appImageDownloadUrl) || !core.isAllowedGitHubUrl(sha256DownloadUrl)) {
    throw new Error('Missing or untrusted official GitHub asset URLs for AppImage update.')
  }

  emitLog(
    'info',
    `[update] Downloading v${updateInfo?.latestVersion || 'latest'} AppImage and .sha256 checksum...`,
  )

  const tmpPath = `${appImagePath}.update.tmp`
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  } catch {
    // Ignore stale temporary file cleanup errors
  }

  emitUpdateProgress({ stage: 'fetching-checksum', percent: 0 })
  const sha256Raw = await core.fetchHttpsText(
    sha256DownloadUrl,
    15000,
    core.MAX_REDIRECTS,
    LINUX_USER_AGENT,
  )
  const expectedSha256 = core.parseSha256Digest(sha256Raw)

  emitUpdateProgress({ stage: 'downloading', downloadedBytes: 0, totalBytes: 0, percent: 0 })
  const { actualSha256, downloadedBytes } = await core.downloadHttpsToFileWithSha256(
    appImageDownloadUrl,
    tmpPath,
    emitUpdateProgress,
    120000,
    core.MAX_REDIRECTS,
    LINUX_USER_AGENT,
  )

  emitUpdateProgress({ stage: 'verifying', percent: 100 })
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // Ignore
    }
    throw new Error(
      `SHA-256 verification failed: expected ${expectedSha256}, computed ${actualSha256}. Temporary update deleted.`,
    )
  }

  try {
    fs.chmodSync(tmpPath, 0o755)
    fs.renameSync(tmpPath, appImagePath)
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // Ignore
    }
    throw err
  }

  emitUpdateProgress({
    stage: 'complete',
    percent: 100,
    sha256: actualSha256,
    downloadedBytes,
    appImagePath,
  })
  emitLog(
    'info',
    `[update] SHA-256 verified (${actualSha256.slice(0, 12)}...). Replaced ${appImagePath} in-place.`,
  )

  if (opts?.relaunch !== false) {
    setTimeout(() => {
      void (async () => {
        try {
          await prepareForRelaunch()
        } catch {
          // Ignore child shutdown errors before relaunch
        }
        try {
          const cleanEnv = { ...process.env }
          delete cleanEnv.APPDIR
          delete cleanEnv.APPIMAGE
          delete cleanEnv.ARGV0
          delete cleanEnv.OWD
          delete cleanEnv.APPIMAGE_UUID
          const child = spawn(appImagePath, core.getCliArgs(), {
            detached: true,
            stdio: 'ignore',
            env: cleanEnv,
          })
          child.unref()
        } catch {
          try {
            app.relaunch({ execPath: appImagePath, args: core.getCliArgs() })
          } catch {
            // Ignore relaunch error in test environments
          }
        }
        void shutdown('self-update-relaunch', 0)
      })()
    }, 450)
  }

  return {
    ok: true,
    appImagePath,
    sha256: actualSha256,
    downloadedBytes,
    version: updateInfo?.latestVersion || '',
  }
}

void core
  .createLauncherApp({
    baseDir: __dirname,
    platformName: 'Linux x64',
    syncHelpLines: [
      '  --setup-sync        Write EDEN_NX2_DEBUG_SERVER=<host>:<port> to',
      '                      ~/.config/{lichii,fritchii,eden,cheezyemu}/nx2_switches.txt and',
      '                      ~/.local/share/{lichii,fritchii,eden,cheezyemu}/nx2_switches.txt and exit',
    ],
    getSettingsPath: () => path.join(getConfigDir(), 'launcher.json'),
    getSaveSettingsPath: () => path.join(getConfigDir(), 'settings.json'),
    resolveRuntimePaths,
    setupSync,
    detectRuntime: detectLinuxRuntime,
    scanRunningRecompProcess,
    detectRecompSaveDir,
    detectNx2SariaProfileDir,
    getPtraceScope: readYamaPtraceScope,
    hasDisplay: () => Boolean(process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim()),
    quitOnWindowAllClosed: true,
    setLogSink: (sink) => {
      bridgeLogSink = sink
    },
    beforeSpawnBridge: (target, state, emitLog) => {
      if (!warnedPtrace && state.ptraceScope !== null && state.ptraceScope !== 0) {
        warnedPtrace = true
        emitLog(
          'warn',
          `[bridge] Warning: /proc/sys/kernel/yama/ptrace_scope is ${state.ptraceScope} while ${target.name} (PID ${target.pid}) is running.`,
        )
        emitLog('warn', '[bridge] Run: sudo sysctl kernel.yama.ptrace_scope=0')
      }
    },
    updateOptions: {
      userAgent: LINUX_USER_AGENT,
      assetCandidates: [LINUX_APPIMAGE_ASSET_NAME],
      allowInPlaceAppImage: true,
    },
    applyUpdate: applyAppImageUpdate,
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
