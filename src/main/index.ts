import { app, shell, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import winIcon from '../../resources/icon.ico?asset'
import { registerIpc } from './ipc'

const APP_ID = 'dev.adalbertocv.agentify'
// The Artifacts tab's claude.ai login; the renderer uses the same name.
const CLAUDE_PARTITION = 'persist:claude'
const SIGN_IN = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com)\//

// Separate profile for automated runs, so they never touch the real settings or secrets.
if (process.env.AGENTIFY_USER_DATA) app.setPath('userData', process.env.AGENTIFY_USER_DATA)

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    title: 'Agentify-Workflow',
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  // Run from source the process is electron.exe, and the taskbar would show Electron's icon:
  // give the window its own app id and icon.
  if (process.platform === 'win32' && !app.isPackaged)
    mainWindow.setAppDetails({
      appId: APP_ID,
      appIconPath: winIcon,
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Agentify-Workflow'
    })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Links inside a session's browser pane open in that same pane, not in a new window.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        // Signing in to claude.ai with Google or Apple opens a popup that reports back to the page
        // that opened it: it has to be a real window, or the sign-in never finishes.
        if (contents.session === session.fromPartition(CLAUDE_PARTITION) && SIGN_IN.test(url))
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true }
          }
        contents.loadURL(url)
        return { action: 'deny' }
      })
      // The popup looks like the page that opened it, so Google does not refuse an embedded browser.
      contents.on('did-create-window', (child) =>
        child.webContents.setUserAgent(contents.getUserAgent())
      )
    }
  })

  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
