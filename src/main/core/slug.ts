export function sessionIdFor(ticket: string): string {
  return ticket
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
}

export function dbNameFor(sessionId: string): string {
  return `agentify_${sessionId.replace(/[^a-z0-9]+/g, '_')}`
}
