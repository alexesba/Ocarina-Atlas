import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '..')

const RELEASE_DIR = path.join(ROOT_DIR, 'release')
const STAGE_DIR = path.join(ROOT_DIR, 'dist-macos-app')

const DIST_DIR = path.join(ROOT_DIR, 'dist')
const STANDALONE_ENTRY = path.join(ROOT_DIR, 'scripts', 'server-entry.ts')
const STANDALONE_OUT = path.join(DIST_DIR, 'standalone-server.mjs')

const MACOS_APP_SRC_DIR = path.join(ROOT_DIR, 'launcher', 'macos-app')
const DESKTOP_ELECTRON_DIR = path.join(ROOT_DIR, 'launcher', 'desktop-electron')
const BRIDGE_C_SRC = path.join(ROOT_DIR, 'launcher', 'macos', 'longshot_rpc_bridge.c')
const ICON_CANDIDATES = [
  path.join(ROOT_DIR, 'public', 'icons', 'icon-512.png'),
  path.join(ROOT_DIR, 'public', 'apple-touch-icon.png'),
  path.join(ROOT_DIR, 'public', 'icons', 'apple-touch-icon.png'),
]

function parseBuildArgs(argv) {
  const opts = {
    skipBuild: false,
    skipNative: false,
    skipPackage: false,
    arch: 'all',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') opts.skipBuild = true
    else if (arg === '--skip-native') opts.skipNative = true
    else if (arg === '--skip-package') opts.skipPackage = true
    else if (arg === '--arch') {
      const val = argv[++i]
      if (val !== 'all' && val !== 'arm64' && val !== 'x64') {
        throw new Error(`Invalid --arch value: ${val} (expected all, arm64, or x64)`)
      }
      opts.arch = val
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/build-macos.mjs [--skip-build] [--skip-native] [--skip-package] [--arch all|arm64|x64]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return opts
}

function runStep(label, command, args, options = {}) {
  console.log(`\n==> ${label}`)
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    ...options,
  })
}

function assertExists(targetPath, description) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing expected ${description}: ${targetPath}`)
  }
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function findCommand(cmd) {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = path.join(dir, cmd)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function normalizeSemver(rawVersion) {
  const cleaned = String(rawVersion || '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(cleaned)
  if (!match) {
    return '0.0.0'
  }
  const base = `${match[1]}.${match[2]}.${match[3]}`
  if (!match[4]) return base
  const prerelease = match[4]
    .split('.')
    .map((part) => part.replace(/[^0-9A-Za-z-]/g, ''))
    .filter(Boolean)
    .join('.')
  return prerelease ? `${base}-${prerelease}` : base
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function copyTextLf(srcPath, destPath) {
  const content = fs.readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n')
  fs.writeFileSync(destPath, content, 'utf8')
}

function ensureMacosPackagerDeps() {
  const sharedBuilderDir = path.join(DESKTOP_ELECTRON_DIR, 'node_modules', 'electron-builder')
  const rootBuilderDir = path.join(ROOT_DIR, 'node_modules', 'electron-builder')
  if (fs.existsSync(sharedBuilderDir) || fs.existsSync(rootBuilderDir)) {
    return
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  runStep(
    `Installing Electron packager dependencies (${path.relative(ROOT_DIR, DESKTOP_ELECTRON_DIR)})`,
    npmCmd,
    ['install', '--no-audit', '--no-fund'],
    { cwd: DESKTOP_ELECTRON_DIR },
  )
}

function resolveElectronVersion() {
  const candidates = [
    path.join(DESKTOP_ELECTRON_DIR, 'node_modules', 'electron', 'package.json'),
    path.join(ROOT_DIR, 'node_modules', 'electron', 'package.json'),
  ]
  for (const pkgPath of candidates) {
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath)
      if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
        return normalizeSemver(pkg.version)
      }
    }
  }
  const packagerPkgPath = path.join(DESKTOP_ELECTRON_DIR, 'package.json')
  if (fs.existsSync(packagerPkgPath)) {
    const packagerPkg = readJson(packagerPkgPath)
    const rawRange = packagerPkg?.devDependencies?.electron
    if (typeof rawRange === 'string') {
      return normalizeSemver(rawRange.replace(/^[\^~>=<]+/, ''))
    }
  }
  throw new Error(
    'Unable to resolve Electron version from launcher/desktop-electron or root node_modules',
  )
}

function resolveElectronBuilderBin() {
  const binName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
  const candidates = [
    path.join(DESKTOP_ELECTRON_DIR, 'node_modules', '.bin', binName),
    path.join(DESKTOP_ELECTRON_DIR, 'node_modules', '.bin', 'electron-builder'),
    path.join(DESKTOP_ELECTRON_DIR, 'node_modules', 'electron-builder', 'cli.js'),
    path.join(ROOT_DIR, 'node_modules', '.bin', binName),
    path.join(ROOT_DIR, 'node_modules', '.bin', 'electron-builder'),
    path.join(ROOT_DIR, 'node_modules', 'electron-builder', 'cli.js'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    `Missing electron-builder CLI in ${path.join(DESKTOP_ELECTRON_DIR, 'node_modules', '.bin', 'electron-builder')} or root node_modules`,
  )
}

function generateMacIcns(iconPngSrc, buildDir) {
  const icnsOutPath = path.join(buildDir, 'icon.icns')
  const sipsPath = findCommand('sips')
  const iconutilPath = findCommand('iconutil')

  if (process.platform !== 'darwin' || !sipsPath || !iconutilPath) {
    console.warn('Skipping .icns generation (sips/iconutil only available on macOS).')
    return false
  }

  const iconsetDir = path.join(buildDir, 'icon.iconset')
  fs.rmSync(iconsetDir, { recursive: true, force: true })
  fs.mkdirSync(iconsetDir, { recursive: true })

  const entries = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]

  console.log('\n==> Generating macOS .icns app icon via sips + iconutil')
  for (const [filename, size] of entries) {
    execFileSync(
      sipsPath,
      [
        '-s',
        'format',
        'png',
        '-z',
        String(size),
        String(size),
        iconPngSrc,
        '--out',
        path.join(iconsetDir, filename),
      ],
      { cwd: ROOT_DIR, stdio: 'pipe' },
    )
  }

  execFileSync(iconutilPath, ['-c', 'icns', iconsetDir, '-o', icnsOutPath], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  })
  fs.rmSync(iconsetDir, { recursive: true, force: true })
  assertExists(icnsOutPath, 'generated build/icon.icns')
  return true
}

function main() {
  const opts = parseBuildArgs(process.argv.slice(2))

  const mainSrc = path.join(MACOS_APP_SRC_DIR, 'main.cjs')
  const sharedCoreSrc = path.join(DESKTOP_ELECTRON_DIR, 'shared-core.cjs')
  const preloadSrc = path.join(DESKTOP_ELECTRON_DIR, 'preload.cjs')
  const htmlSrc = path.join(DESKTOP_ELECTRON_DIR, 'index.html')

  assertExists(mainSrc, 'macOS Electron main process entry')
  assertExists(sharedCoreSrc, 'Electron shared core module')
  assertExists(preloadSrc, 'Electron preload script')
  assertExists(htmlSrc, 'Electron launcher HTML')
  assertExists(BRIDGE_C_SRC, 'macOS Longshot RPC bridge C source')

  if (!opts.skipPackage) {
    ensureMacosPackagerDeps()
  }

  const rootPkg = readJson(path.join(ROOT_DIR, 'package.json'))
  const electronVersion = resolveElectronVersion()
  const normalizedVersion = normalizeSemver(rootPkg.version)
  const targetArches = opts.arch === 'all' ? ['arm64', 'x64'] : [opts.arch]

  if (!opts.skipBuild) {
    const viteCli = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
    const rolldownCli = path.join(ROOT_DIR, 'node_modules', 'rolldown', 'bin', 'cli.mjs')
    assertExists(viteCli, 'Vite CLI')
    assertExists(rolldownCli, 'Rolldown CLI')
    assertExists(STANDALONE_ENTRY, 'standalone server entry')

    runStep('Building Vite client + SSR app (dist/)', process.execPath, [viteCli, 'build'])
    runStep('Bundling standalone server (dist/standalone-server.mjs)', process.execPath, [
      rolldownCli,
      STANDALONE_ENTRY,
      '--platform',
      'node',
      '--format',
      'esm',
      '--minify',
      '-o',
      STANDALONE_OUT,
    ])
  }

  const distClient = path.join(DIST_DIR, 'client')
  const distServer = path.join(DIST_DIR, 'server')
  assertExists(STANDALONE_OUT, 'standalone server bundle')
  assertExists(distClient, 'dist/client directory')
  assertExists(path.join(distServer, 'server.js'), 'dist/server/server.js')
  assertExists(path.join(distServer, 'package.json'), 'dist/server/package.json')

  console.log(`\n==> Staging macOS app directory: ${STAGE_DIR}`)
  fs.rmSync(STAGE_DIR, { recursive: true, force: true })
  fs.mkdirSync(RELEASE_DIR, { recursive: true })

  const appDir = path.join(STAGE_DIR, 'app')
  const appDistDir = path.join(appDir, 'dist')
  const binDir = path.join(STAGE_DIR, 'bin')
  const buildDir = path.join(STAGE_DIR, 'build')

  fs.mkdirSync(appDistDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(buildDir, { recursive: true })

  // Electron app shell files (CRLF -> LF)
  copyTextLf(mainSrc, path.join(STAGE_DIR, 'main.cjs'))
  copyTextLf(sharedCoreSrc, path.join(STAGE_DIR, 'shared-core.cjs'))
  copyTextLf(preloadSrc, path.join(STAGE_DIR, 'preload.cjs'))
  copyTextLf(htmlSrc, path.join(STAGE_DIR, 'index.html'))

  // Bundled standalone server & Vite client/SSR artifacts
  fs.copyFileSync(STANDALONE_OUT, path.join(appDir, 'standalone-server.mjs'))
  fs.cpSync(distClient, path.join(appDistDir, 'client'), { recursive: true })
  fs.cpSync(distServer, path.join(appDistDir, 'server'), { recursive: true })

  // Icon
  const iconSrc = ICON_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!iconSrc) {
    throw new Error('No application icon found in public/icons/icon-512.png or public/apple-touch-icon.png')
  }
  fs.copyFileSync(iconSrc, path.join(buildDir, 'icon.png'))
  const hasIcns = generateMacIcns(iconSrc, buildDir)

  // License
  const extraResources = [
    { from: 'app', to: 'app' },
    { from: 'build/icon.png', to: 'build/icon.png' },
  ]
  if (hasIcns) {
    extraResources.push({ from: 'build/icon.icns', to: 'build/icon.icns' })
  }
  const licenseSrc = path.join(ROOT_DIR, 'LICENSE')
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(STAGE_DIR, 'LICENSE'))
    extraResources.push({ from: 'LICENSE', to: 'LICENSE' })
  }

  // Stage minimal package.json
  const stagedPkg = {
    name: 'ocarina-atlas',
    version: normalizedVersion,
    description: 'Interactive Ocarina of Time Remake map & live telemetry launcher',
    main: 'main.cjs',
    license: 'AGPL-3.0',
    author: 'antonioalvromero',
  }
  fs.writeFileSync(
    path.join(STAGE_DIR, 'package.json'),
    `${JSON.stringify(stagedPkg, null, 2)}\n`,
    'utf8',
  )

  const clangPath = !opts.skipNative && process.platform === 'darwin' ? findCommand('clang') : null
  if (!opts.skipNative && process.platform === 'darwin' && !clangPath) {
    throw new Error(
      'clang was not found on PATH. Install Xcode Command Line Tools (`xcode-select --install`) or pass --skip-native.',
    )
  }
  if (!opts.skipNative && process.platform !== 'darwin') {
    console.warn(
      `WARN: Skipping native clang compilation of longshot_rpc_bridge.c on ${process.platform} (run on macOS for full binary).`,
    )
  }

  const builtArtifacts = []

  for (const targetArch of targetArches) {
    const dmgName = `OcarinaAtlas-MacOS-${targetArch}.dmg`
    const zipName = `OcarinaAtlas-MacOS-${targetArch}.zip`
    const dmgPath = path.join(RELEASE_DIR, dmgName)
    const zipPath = path.join(RELEASE_DIR, zipName)

    fs.rmSync(dmgPath, { force: true })
    fs.rmSync(zipPath, { force: true })
    fs.rmSync(binDir, { recursive: true, force: true })
    fs.mkdirSync(binDir, { recursive: true })

    let bridgeSize = null
    if (opts.skipNative) {
      console.log(`Skipping native longshot-rpc-bridge compilation for ${targetArch} (--skip-native).`)
    } else if (clangPath) {
      const clangArch = targetArch === 'x64' ? 'x86_64' : 'arm64'
      const bridgeOutPath = path.join(binDir, 'longshot-rpc-bridge')
      runStep(
        `Compiling thin macOS Longshot RPC bridge (${clangPath}, ${clangArch})`,
        clangPath,
        [
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-pthread',
          '-std=c99',
          '-arch',
          clangArch,
          '-o',
          bridgeOutPath,
          BRIDGE_C_SRC,
        ],
      )
      assertExists(bridgeOutPath, `compiled bin/longshot-rpc-bridge (${targetArch})`)
      fs.chmodSync(bridgeOutPath, 0o755)
      bridgeSize = fs.statSync(bridgeOutPath).size
    }

  const builderConfig = {
    appId: 'io.github.antonioalvromero.ocarinaatlas',
    productName: 'Ocarina Atlas',
    electronVersion,
    directories: {
      buildResources: 'build',
      output: '../release',
    },
    files: ['main.cjs', 'shared-core.cjs', 'preload.cjs', 'index.html', 'package.json'],
    extraResources,
    mac: {
      target: [
        { target: 'dmg', arch: [targetArch] },
        { target: 'zip', arch: [targetArch] },
      ],
      category: 'public.app-category.games',
      icon: hasIcns ? 'build/icon.icns' : 'build/icon.png',
      identity: null,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      artifactName: `OcarinaAtlas-MacOS-${targetArch}.\${ext}`,
    },
  }

  const builderConfigPath = path.join(STAGE_DIR, 'electron-builder.config.cjs')
  const builderConfigSource = `const fs = require('node:fs')
const path = require('node:path')

const config = ${JSON.stringify(builderConfig, null, 2)}

config.afterPack = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const srcBridge = path.join(__dirname, 'bin', 'longshot-rpc-bridge')
  if (!fs.existsSync(srcBridge)) return
  const productFilename = context.packager?.appInfo?.productFilename || 'Ocarina Atlas'
  const destBinDir = path.join(
    context.appOutDir,
    \`\${productFilename}.app\`,
    'Contents',
    'Resources',
    'bin',
  )
  fs.mkdirSync(destBinDir, { recursive: true })
  const destBridge = path.join(destBinDir, 'longshot-rpc-bridge')
  fs.copyFileSync(srcBridge, destBridge)
  fs.chmodSync(destBridge, 0o755)
}

module.exports = config
`
  fs.writeFileSync(builderConfigPath, builderConfigSource, 'utf8')

  if (!opts.skipPackage) {
    ensureMacosPackagerDeps()
    const electronBuilderBin = resolveElectronBuilderBin()
    const builderArgs = ['--mac', '--config', builderConfigPath, '--projectDir', STAGE_DIR]
    const builderEnv = {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    }
    if (
      electronBuilderBin.endsWith('.js') ||
      electronBuilderBin.endsWith('.cjs') ||
      electronBuilderBin.endsWith('.mjs')
    ) {
      runStep(
        `Packaging macOS ${targetArch} DMG & ZIP (${dmgName}, ${zipName})`,
        process.execPath,
        [electronBuilderBin, ...builderArgs],
        { env: builderEnv },
      )
    } else {
      runStep(
        `Packaging macOS ${targetArch} DMG & ZIP (${dmgName}, ${zipName})`,
        electronBuilderBin,
        builderArgs,
        { env: builderEnv },
      )
    }
    assertExists(dmgPath, `macOS ${targetArch} DMG`)
    assertExists(zipPath, `macOS ${targetArch} ZIP`)
  }

    builtArtifacts.push({ targetArch, bridgeSize, dmgPath, zipPath })
  }

  console.log('\nmacOS app build completed:')
  console.log(`  Staged   : ${STAGE_DIR} (v${normalizedVersion}, arches=${targetArches.join(', ')})`)
  for (const item of builtArtifacts) {
    if (item.bridgeSize !== null) {
      console.log(`  Bridge (${item.targetArch}): ${formatMb(item.bridgeSize)}`)
    }
    if (fs.existsSync(item.dmgPath)) {
      console.log(`  DMG (${item.targetArch})   : ${item.dmgPath} (${formatMb(fs.statSync(item.dmgPath).size)})`)
    }
    if (fs.existsSync(item.zipPath)) {
      console.log(`  ZIP (${item.targetArch})   : ${item.zipPath} (${formatMb(fs.statSync(item.zipPath).size)})`)
    }
  }
}

main()
