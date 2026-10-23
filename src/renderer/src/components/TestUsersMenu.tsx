import { useEffect, useRef, useState } from 'react'
import type { TestUser } from '../../../shared/api'

/** Fills the visible login form of the page: an email/username field and a password field. */
const FILL_LOGIN = `(function (email, password) {
  const visible = (el) => el && el.offsetParent !== null && !el.disabled
  const inputs = [...document.querySelectorAll('input')].filter(visible)
  const pass = inputs.find((i) => i.type === 'password')
  const user =
    inputs.find((i) => i.type === 'email') ||
    inputs.find((i) => /user|email|login|correo/i.test((i.name || '') + (i.id || '') + (i.autocomplete || ''))) ||
    (pass ? inputs[inputs.indexOf(pass) - 1] : undefined)
  const set = (el, value) => {
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
    setter.call(el, value) // React and friends listen to the native setter + input event
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  return set(user, email) && set(pass, password)
})`

export function TestUsersMenu({
  users,
  canFill,
  fill,
  notify
}: {
  users: TestUser[]
  canFill: boolean
  fill: (script: string) => Promise<unknown>
  notify: (msg: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (!users.length) return null

  const copy = async (text: string, what: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    notify(`${what} copiado`)
  }

  const fillLogin = async (u: TestUser): Promise<void> => {
    const ok = await fill(`${FILL_LOGIN}(${JSON.stringify(u.email)}, ${JSON.stringify(u.password)})`)
    notify(ok ? `Login llenado con ${u.email}` : 'No encontré un formulario de login en esta página')
    if (ok) setOpen(false)
  }

  return (
    <div className="users-menu" ref={box}>
      <button title="Usuarios de prueba de la base de esta sesión" onClick={() => setOpen(!open)}>
        👤 Usuarios
      </button>
      {open && (
        <div className="users-pop">
          {users.map((u) => (
            <div className="user-row" key={u.email}>
              <div className="user-id">
                {u.label && <b>{u.label}</b>}
                <span className="mono">{u.email}</span>
                <span className="mono muted">{u.password}</span>
              </div>
              <div className="row">
                <button className="primary" disabled={!canFill} onClick={() => fillLogin(u)}>
                  Llenar
                </button>
                <button className="ghost" title="Copiar correo" onClick={() => copy(u.email, 'Correo')}>
                  ✉
                </button>
                <button className="ghost" title="Copiar contraseña" onClick={() => copy(u.password, 'Contraseña')}>
                  🔑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
