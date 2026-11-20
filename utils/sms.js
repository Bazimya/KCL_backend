// Text messages to customers (order received / ready, booking and training
// updates). One function, swappable delivery:
//
//   SMS_DRIVER=log            (default) nothing is sent - each message is
//                             printed to the console and appended to
//                             logs/sms.log so you can see exactly what
//                             customers would receive. Use in development.
//   SMS_DRIVER=africastalking sends through Africa's Talking. With
//                             AT_USERNAME=sandbox it uses their free sandbox
//                             (messages show in the sandbox simulator, not on
//                             real phones); with your live username it sends
//                             real SMS. Needs AT_API_KEY; AT_SENDER_ID optional.
//
// sendSms never throws: a failed text must never fail the order, booking or
// application that triggered it.
const fs = require('fs')
const path = require('path')
const { normalizePhone } = require('./phone')

const driver = () => (process.env.SMS_DRIVER || 'log').trim().toLowerCase()

// Rwandan numbers to international format: 078..., 25078..., +25078... -> +25078...
const toE164 = (phone) => {
    const p = normalizePhone(phone)
    if (!p || /[^+\d]/.test(p)) return null
    if (p.startsWith('+')) return p.length >= 11 ? p : null
    if (p.startsWith('250') && p.length === 12) return `+${p}`
    if (p.startsWith('0') && p.length === 10) return `+250${p.slice(1)}`
    if (p.length === 9) return `+250${p}`
    return null
}

const logFile = () => process.env.SMS_LOG_FILE || path.join(__dirname, '..', 'logs', 'sms.log')

const sendViaLog = async (to, message) => {
    const line = `${new Date().toISOString()}  TO ${to}  ${message}`
    console.log(`[SMS:log] ${line}`)
    const file = logFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line + '\n')
}

const sendViaAfricasTalking = async (to, message) => {
    const username = process.env.AT_USERNAME
    const apiKey = process.env.AT_API_KEY
    if (!username || !apiKey) throw new Error('AT_USERNAME and AT_API_KEY must be set for SMS_DRIVER=africastalking')
    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com'
    const body = new URLSearchParams({ username, to, message })
    if (process.env.AT_SENDER_ID) body.set('from', process.env.AT_SENDER_ID)
    const res = await fetch(`https://${host}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`Africa's Talking responded HTTP ${res.status}`)
    const json = await res.json().catch(() => ({}))
    const recipient = json?.SMSMessageData?.Recipients?.[0]
    if (recipient && recipient.status !== 'Success') throw new Error(`Africa's Talking: ${recipient.status}`)
}

const sendSms = async (phone, message) => {
    const to = toE164(phone)
    if (!to) return { sent: false, reason: 'no valid phone number' }
    try {
        if (driver() === 'africastalking') await sendViaAfricasTalking(to, message)
        else await sendViaLog(to, message)
        return { sent: true }
    } catch (err) {
        console.error(`[SMS] could not send to ${to}: ${err.message}`)
        return { sent: false, reason: err.message }
    }
}

// Fire-and-forget: don't make the customer wait for the SMS provider.
const notifySms = (phone, message) => { sendSms(phone, message).catch(() => {}) }

// "20 Nov 2026, 14:30" in Kigali time, whatever timezone the server runs in.
const kigaliTime = (date) => new Date(date).toLocaleString('en-GB', {
    timeZone: 'Africa/Kigali', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const smsStartupNote = () => {
    if (driver() === 'africastalking') {
        if (!process.env.AT_USERNAME || !process.env.AT_API_KEY) console.warn('[SMS] SMS_DRIVER=africastalking but AT_USERNAME / AT_API_KEY are missing - texts will fail')
        else console.log(`[SMS] sending through Africa's Talking (${process.env.AT_USERNAME === 'sandbox' ? 'sandbox' : 'live'})`)
    } else {
        console.log(`[SMS] development mode - texts are not sent, they are logged to ${logFile()}`)
    }
}

module.exports = { sendSms, notifySms, toE164, kigaliTime, smsStartupNote }
