import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './design.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 缺失')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
