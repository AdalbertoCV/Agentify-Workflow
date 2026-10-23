import type { AgentifyApi } from '../shared/api'

declare global {
  interface Window {
    agentify: AgentifyApi
  }
}
