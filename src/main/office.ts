import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, Notification } from 'electron'
import { fireRoutine, readStore, writeStore, type BotConfig, type BotRun } from './core/bots'
import { saveConfig, type AppConfig } from './core/config'
import { prState } from './core/github'
import { addIssueLabel, commentOnIssue, labelledIssues } from './core/linear'
import { buildDesks, iterateText, planIterations, type Desk } from './core/office'
import { runResolved } from './core/proc'
import { getSecret, setSecret } from './secrets'

const WATCH_MS = 60_000
// The routine allows 30 fires an hour; keep a margin for "Run now" in claude.ai.
const HOURLY_GUARD = 28

/**
 * The Office: cloud bots working tickets. Desks are rebuilt from Linear and GitHub every minute while
 * the app is open; changes to red or green raise a notification, and red PRs get one iteration at a time.
 */
export function registerOffice(
  requireCfg: () => AppConfig,
  setCfg: (c: AppConfig) => void,
  broadcast: (channel: string, ...args: unknown[]) => void
): void {
  let desks: Desk[] = []
  let refreshing: Promise<Desk[]> | null = null

  const botOf = (id: string): BotConfig => {
    const bot = requireCfg().bots?.find((b) => b.id === id)
    if (!bot) throw new Error(`No existe el bot ${id}`)
    return bot
  }
  const linearKey = (): string => {
    const key = getSecret('linear')
    if (!key) throw new Error('La Oficina lee a los bots en Linear: conecta Linear en Conectores')
    return key
  }

  const fire = async (
    botId: string,
    ticket: string,
    kind: BotRun['kind'],
    text: string
  ): Promise<void> => {
    const c = requireCfg()
    const bot = botOf(botId)
    const token = getSecret(`bot:${botId}`)
    if (!token) throw new Error(`Falta el token de ${bot.name}: pégalo en ⚙ Bots`)
    const store = readStore(c.root)
    const lastHour = store.runs.filter(
      (r) => r.botId === botId && Date.now() - Date.parse(r.firedAt) < 3600_000
    )
    if (lastHour.length >= HOURLY_GUARD)
      throw new Error(
        `${bot.name} ya corrió ${lastHour.length} veces en la última hora (límite 30); espera un poco`
      )
    const session = await fireRoutine(bot.routineId, token, text)
    store.runs.push({
      id: randomUUID(),
      botId,
      ticket,
      kind,
      firedAt: new Date().toISOString(),
      ...session,
      text
    })
    writeStore(c.root, store)
  }

  const notify = (before: Desk[], after: Desk[]): void => {
    if (!Notification.isSupported()) return
    for (const d of after) {
      const prev = before.find((x) => x.key === d.key)
      if (!prev || prev.status === d.status) continue
      if (d.status !== 'needs-you' && d.status !== 'done') continue
      const n = new Notification({
        title:
          d.status === 'needs-you'
            ? `${d.botName} te necesita · ${d.ticket}`
            : `${d.botName} terminó ${d.ticket}`,
        body: d.status === 'needs-you' ? (d.question ?? d.bubble) : d.bubble
      })
      n.on('click', () => {
        const w = BrowserWindow.getAllWindows()[0]
        w?.show()
        w?.focus()
        broadcast('office:focus', d.key)
      })
      n.show()
    }
  }

  const refresh = (): Promise<Desk[]> => {
    refreshing ??= (async () => {
      const c = requireCfg()
      const bots = c.bots ?? []
      const key = getSecret('linear')
      if (!bots.length || !key) return (desks = [])
      const gh = async (args: string[]): Promise<string> =>
        (await runResolved('gh', args, { cwd: c.root })).stdout
      const now = Date.now()
      const next = await buildDesks(bots, {
        issues: (label) => labelledIssues(key, label),
        pr: (url, readyCheck) => prState(url, readyCheck, gh),
        store: readStore(c.root),
        now
      })
      for (const it of planIterations(bots, next, readStore(c.root), now))
        await fire(it.botId, it.ticket, 'iterate', it.text).catch((e) =>
          broadcast('sessions:progress', `✗ ${it.ticket}: ${(e as Error).message}`)
        )
      notify(desks, next)
      desks = next
      broadcast('office:changed', desks)
      return desks
    })().finally(() => (refreshing = null))
    return refreshing
  }

  setInterval(() => void refresh().catch(() => {}), WATCH_MS)

  const deskOf = (key: string): Desk => {
    const d = desks.find((x) => x.key === key)
    if (!d) throw new Error('Ese escritorio ya no está; actualiza la Oficina')
    return d
  }

  ipcMain.handle('office:desks', () => (desks.length ? desks : refresh()))
  ipcMain.handle('office:refresh', () => refresh())
  ipcMain.handle('office:assign', async (_e, botId: string, ticket: string) => {
    const bot = botOf(botId)
    const busy = desks.find((d) => d.ticket === ticket && d.active)
    if (busy) throw new Error(`${ticket} ya tiene a ${busy.botName} trabajando`)
    await addIssueLabel(linearKey(), ticket, bot.label)
    await fire(botId, ticket, 'start', `Ticket: ${ticket}`)
    return refresh()
  })
  ipcMain.handle('office:answer', async (_e, key: string, text: string) => {
    const d = deskOf(key)
    await commentOnIssue(linearKey(), d.ticket, text)
    await fire(
      d.botId,
      d.ticket,
      'answer',
      `Ticket: ${d.ticket}\nRespuesta del dueño a tu pregunta: ${text}`
    )
    return refresh()
  })
  ipcMain.handle('office:iterate', async (_e, key: string) => {
    const d = deskOf(key)
    await fire(
      d.botId,
      d.ticket,
      'iterate',
      d.pr ? iterateText(d.ticket, d.pr) : `Ticket: ${d.ticket}`
    )
    return refresh()
  })
  ipcMain.handle('office:retry', async (_e, key: string) => {
    const d = deskOf(key)
    await fire(d.botId, d.ticket, 'start', `Ticket: ${d.ticket}`)
    return refresh()
  })
  ipcMain.handle('office:dismiss', (_e, key: string) => {
    const c = requireCfg()
    const store = readStore(c.root)
    store.dismissed = [
      ...store.dismissed.filter((d) => d.key !== key),
      { key, at: new Date().toISOString() }
    ]
    writeStore(c.root, store)
    return refresh()
  })
  ipcMain.handle('bots:save', (_e, bots: BotConfig[], tokens: Record<string, string>) => {
    for (const [id, token] of Object.entries(tokens))
      if (token.trim()) setSecret(`bot:${id}`, token.trim())
    const c = { ...requireCfg(), bots }
    saveConfig(c)
    setCfg(c)
    desks = []
    return c
  })
  ipcMain.handle('bots:has-token', (_e, id: string) => Boolean(getSecret(`bot:${id}`)))
}
