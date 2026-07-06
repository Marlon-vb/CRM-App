import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './theme.css'
import App from './App.jsx'

// HashRouter (not BrowserRouter) — Cadence ships as an Electron app loading
// the built index.html from disk (file://). BrowserRouter relies on the
// server returning index.html for any path, which file:// can't do; HashRouter
// puts the route in the URL fragment (#/queue) so the browser never asks the
// "server" for anything past the index. Same approach used by every Electron
// SPA we've ported.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
