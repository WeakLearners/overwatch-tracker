import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { loadRoster } from './lib/roster'

// The roster (heroes, maps, seasons, cached portraits) loads before the app
// module does: pages read it at import time, e.g. the map pickers.
loadRoster().then(() => import('./App')).then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
