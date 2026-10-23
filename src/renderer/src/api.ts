import { useEffect, useRef } from 'react'

export const api = window.agentify

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron prefixes errors thrown in main: "Error invoking remote method 'x': Error: ..."
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

export function useInterval(fn: () => void, ms: number | null): void {
  const saved = useRef(fn)
  saved.current = fn
  useEffect(() => {
    if (ms === null) return
    const t = setInterval(() => saved.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}
