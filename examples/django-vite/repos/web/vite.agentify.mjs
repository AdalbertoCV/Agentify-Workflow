// Wraps the project's own vite.config.js: private port per session + proxy to that session's API.
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadConfigFromFile, mergeConfig } from 'vite'

const root = process.cwd()
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.js'), root)
const api = process.env.AGENTIFY_API_TARGET
// node_modules is a link to a shared install: let Vite serve files from its real path too.
const modulesReal = dirname(realpathSync(resolve(root, 'node_modules')))

export default mergeConfig(loaded?.config ?? {}, {
  root,
  server: {
    host: 'localhost',
    port: Number(process.env.AGENTIFY_PORT),
    strictPort: true,
    open: false,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/media': { target: api, changeOrigin: true }
    },
    fs: { allow: [root, modulesReal] }
  }
})
