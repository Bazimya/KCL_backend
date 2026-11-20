// The public, customer-facing site address (the frontend, not this API).
// PUBLIC_APP_URL wins if set; otherwise the FIRST origin in FRONTEND_URL
// (which may be a comma-separated CORS list - not a valid URL on its own).
const publicAppUrl = () => (
    process.env.PUBLIC_APP_URL ||
    (process.env.FRONTEND_URL || '').split(',').map((v) => v.trim()).find(Boolean) ||
    'https://kigalicoffeelab.com'
).replace(/\/+$/, '')

module.exports = { publicAppUrl }
