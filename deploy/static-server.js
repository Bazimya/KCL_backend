// Serves the built frontend (KCL_frontend/dist) as a single-page app, for
// servers where the reverse proxy can't read the files itself (e.g. Caddy
// running in Docker without a mount for this site). Uses the backend's own
// express dependency - nothing extra to install.
//
//   WEB_ROOT=/srv/kcl/KCL_frontend/dist HOST=172.17.0.1 WEB_PORT=5051 node deploy/static-server.js
const path = require('path')
const fs = require('fs')
const express = require('express')

const root = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '..', '..', 'KCL_frontend', 'dist'))
const port = Number(process.env.WEB_PORT || 5051)
const host = process.env.HOST || '127.0.0.1'
const indexFile = path.join(root, 'index.html')

const app = express()
app.disable('x-powered-by')

// Hashed build assets never change - cache for a year. Everything else
// (index.html, logo, etc.) is revalidated so a new deploy shows up at once.
app.use('/assets', express.static(path.join(root, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }))
app.use(express.static(root, { index: false, maxAge: 0 }))

// SPA fallback: /t/<qrToken>, /admin/orders, /track ... all get index.html.
app.get('*', (req, res) => {
    if (!fs.existsSync(indexFile)) return res.status(503).send('Site is being deployed, try again in a moment.')
    res.set('Cache-Control', 'no-cache')
    res.sendFile(indexFile)
})

app.listen(port, host, () => console.log(`KCL web serving ${root} on ${host}:${port}`))
