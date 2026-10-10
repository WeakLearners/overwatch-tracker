import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { loadRoster } from './lib/roster'

// The roster (heroes, maps, seasons, cached portraits) loads before the app
// module does: pages read it at import time, e.g. the map pickers.
// Demo build only: answer every GET from the bundled snapshot before anything
// fetches. VITE_DEMO is a build-time constant, so the normal build keeps none of it.
const ready = import.meta.env.VITE_DEMO === '1'
  ? import('./demo/demoFetch').then(m => m.installDemoFetch())
  : Promise.resolve();

ready.then(loadRoster).then(() => import('./App')).then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
