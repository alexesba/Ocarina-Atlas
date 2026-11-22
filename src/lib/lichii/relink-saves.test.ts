import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  detectEmulatorFromPath,
  findLatestSaveSlotDir,
  getCandidateSaveDirs,
  getRelinkLauncherUserDirs,
  parseRelinkLauncherGameFolder,
} from './save-parser'

const RELINK_UID = '00000000000000010000000000000000'

function writeRelinkLauncherIni(localAppData: string, body: string): void {
  const dir = path.join(localAppData, 'ReLink')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'launcher.ini'), body)
}

function makeSlot(saveRoot: string, mtimeSec: number): string {
  const slot = path.join(saveRoot, 'save', RELINK_UID, 'slot_00')
  fs.mkdirSync(slot, { recursive: true })
  const caption = path.join(slot, 'caption.sav')
  fs.writeFileSync(caption, Buffer.alloc(0x30))
  fs.utimesSync(caption, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000))
  return slot
}

describe('Project ReLink save discovery', () => {
  it('parses game_folder from launcher.ini like the ReLink launcher does', () => {
    expect(parseRelinkLauncherGameFolder('display_60hz=1\r\ngame_folder=D:\\Jogos\\ReLink\r\n')).toBe(
      'D:\\Jogos\\ReLink',
    )
    // BOM, spacing, comments, case-insensitive key, last value wins
    expect(
      parseRelinkLauncherGameFolder(
        '\uFEFF; comment\n# game_folder=C:\\ignored\nGAME_FOLDER = C:\\first\n  game_folder =  /home/me/Games/ReLink  \n',
      ),
    ).toBe('/home/me/Games/ReLink')
    expect(parseRelinkLauncherGameFolder('audio=1\n')).toBeNull()
    expect(parseRelinkLauncherGameFolder('game_folder=\n')).toBeNull()
    expect(parseRelinkLauncherGameFolder('game_folder=C:\\x\ngame_folder=\n')).toBeNull()
  })

  it('returns <game folder>/user from %LOCALAPPDATA%\\ReLink\\launcher.ini and ignores relative or UNC folders', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-launcher-ini-'))
    try {
      const localAppData = path.join(tmpRoot, 'Local')
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([])
      expect(getRelinkLauncherUserDirs(undefined)).toEqual([])

      const gameFolder = path.join(tmpRoot, 'Custom Folder', 'OOT')
      writeRelinkLauncherIni(localAppData, `audio=1\ngame_folder=${gameFolder}\n`)
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([path.resolve(gameFolder, 'user')])

      writeRelinkLauncherIni(localAppData, 'game_folder=relative\\ReLink\n')
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([])

      writeRelinkLauncherIni(localAppData, 'game_folder=\\\\server\\share\\ReLink\n')
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([])

      writeRelinkLauncherIni(localAppData, `game_folder=${gameFolder}\0evil\n`)
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([])

      writeRelinkLauncherIni(localAppData, `game_folder=${gameFolder}\n${'#'.repeat(70 * 1024)}\n`)
      expect(getRelinkLauncherUserDirs(localAppData)).toEqual([])
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('finds saves in a custom ReLink game folder (launcher.ini) and in native Linux $XDG_DATA_HOME/relink', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-saves-'))
    // Keep real ~/Games saves on the test machine out of the newest-slot comparison
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot)
    try {
      const localAppData = path.join(tmpRoot, 'Local')
      const appData = path.join(tmpRoot, 'Roaming')
      const xdgDataHome = path.join(tmpRoot, 'xdg')
      const gameFolder = path.join(tmpRoot, 'Some Drive', 'OcarinaPC')
      writeRelinkLauncherIni(localAppData, `game_folder=${gameFolder}\n`)
      const env = { LOCALAPPDATA: localAppData, APPDATA: appData, XDG_DATA_HOME: xdgDataHome }

      const dirs = getCandidateSaveDirs(env)
      expect(dirs).toContain(path.resolve(gameFolder, 'user'))
      expect(dirs).toContain(path.resolve(xdgDataHome, 'relink'))

      const customSlot = makeSlot(path.join(gameFolder, 'user'), 2000)
      expect(findLatestSaveSlotDir(getCandidateSaveDirs(env))?.dir).toBe(customSlot)
      // The folder name says nothing, so the launcher's remembered folder identifies ReLink
      expect(detectEmulatorFromPath(customSlot, env)).toBe('relink')

      const linuxSlot = makeSlot(path.join(xdgDataHome, 'relink'), 3000)
      expect(findLatestSaveSlotDir(getCandidateSaveDirs(env))?.dir).toBe(linuxSlot)
      expect(detectEmulatorFromPath(linuxSlot, env)).toBe('relink')
    } finally {
      homeSpy.mockRestore()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('attributes saves under RELINK_SAVE_DIR to Project ReLink whatever the folder is called', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-env-'))
    try {
      const custom = path.join(tmpRoot, 'my-saves')
      const env = { RELINK_SAVE_DIR: custom, LOCALAPPDATA: path.join(tmpRoot, 'Local') }
      expect(detectEmulatorFromPath(path.join(custom, 'save', RELINK_UID, 'slot_01'), env)).toBe('relink')
      expect(detectEmulatorFromPath(path.join(tmpRoot, 'elsewhere', 'slot_01'), env)).toBeUndefined()
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
