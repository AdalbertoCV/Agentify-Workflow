import '@xterm/xterm/css/xterm.css'
import 'diff2html/bundles/css/diff2html.min.css'
import './styles.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// No StrictMode: its double mount would attach every terminal twice.
createRoot(document.getElementById('root')!).render(<App />)
