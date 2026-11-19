const morgan = require('morgan')
const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
const path = require('path')
const dotenv = require('dotenv').config()
const { prisma, connectDb } = require('./config/dbConnection')
const express = require('express')
const { notFound, errorHandler } = require('./middlewares/errorHandler')
const cors = require('cors')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')
const { uploadsDir } = require('./config/uploads')
const app = express()

const isProduction = process.env.NODE_ENV === 'production'
const configuredOrigins = process.env.FRONTEND_URL || (isProduction ? '' : 'http://localhost:5173,http://127.0.0.1:5173')
const allowedOrigins = new Set(configuredOrigins.split(',').map((value) => {
    const origin = value.trim()
    if (!origin) return ''
    try {
        const parsed = new URL(origin)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Unsupported protocol')
        }
        return parsed.origin
    } catch {
        throw new Error(`Invalid FRONTEND_URL origin: ${origin}`)
    }
}).filter(Boolean))

const validateRuntimeConfig = () => {
    // PASSWORD_KEY is now only used to verify (and upgrade) passwords created
    // before the switch to bcrypt - see utils/password.js. Keep it set if the
    // database has existing accounts; a brand-new database doesn't need it.
    const required = ['DATABASE_URL', 'JWT_KEY']
    if (isProduction) required.push('FRONTEND_URL')
    const missing = required.filter((name) => !process.env[name]?.trim())
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)

    if (isProduction) {
        for (const name of ['JWT_KEY', 'PASSWORD_KEY']) {
            const value = process.env[name]
            if (name === 'PASSWORD_KEY' && !value) continue
            if (value.length < 32 || /secret|example|change.?me|your.?password/i.test(value)) {
                throw new Error(`${name} must be a strong, non-placeholder secret of at least 32 characters`)
            }
        }
    }
}

const port = Number(process.env.PORT || 5050)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
}

// Behind a hosting provider's load balancer / reverse proxy, req.ip must come
// from X-Forwarded-For or every visitor looks like the same IP to the rate
// limiter. TRUST_PROXY = number of proxy hops (default 1 in production).
const trustProxy = process.env.TRUST_PROXY ?? (isProduction ? '1' : '0')
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy)

// Uploaded images are loaded by the frontend from a different origin, so the
// resource policy must allow cross-origin embedding.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin))
    },
}))
app.use(morgan(isProduction ? 'combined' : 'dev'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended: false}))
app.use(cookieParser())
for (const folder of ['products', 'drinks', 'staff']) {
    app.use(`/uploads/${folder}`, express.static(path.join(uploadsDir, folder)))
}

app.get('/', (req, res) => res.json({ msg: 'Kigali Coffee Lab API is running ☕' }))

// Brute-force protection for login/registration. Failed attempts only, so a
// shared café Wi-Fi IP isn't locked out by normal successful logins.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT || 20),
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { msg: 'Too many attempts, please try again in a few minutes.' },
})
app.use('/auth', authLimiter, require('./routes/authRoute'))
app.use('/users', require('./routes/userRoute'))
app.use('/products', require('./routes/productRoute'))
// /menu is the catalog-facing name for the same coffee+food items /drinks
// serves - kept as an alias so nothing that already calls /drinks breaks.
app.use('/drinks', require('./routes/drinkRoute'))
app.use('/menu', require('./routes/drinkRoute'))
app.use('/carts', require('./routes/cartRoute'))
app.use('/orders', require('./routes/orderRoute'))
app.use('/tables', require('./routes/tableRoute'))
app.use('/notifications', require('./routes/notificationRoute'))
app.use('/settings', require('./routes/settingsRoute'))
app.use('/dashboard', require('./routes/dashboardRoute'))
app.use('/visits', require('./routes/visitRoute'))
app.use('/training', require('./routes/trainingRoute'))
app.use('/staff-stories', require('./routes/staffStoryRoute'))
app.use('/search', require('./routes/searchRoute'))
app.use('/reports', require('./routes/reportRoute'))

app.use(notFound)
app.use(errorHandler)

const start = async () => {
    validateRuntimeConfig()
    await connectDb()
    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`Listening to ${port}`)
            resolve(server)
        })
        server.once('error', reject)
    })
}

if (require.main === module) {
    start().catch(async (error) => {
        console.error('Unable to start KCL API:', error.message)
        await prisma.$disconnect()
        process.exitCode = 1
    })
}

module.exports = { app, start }
