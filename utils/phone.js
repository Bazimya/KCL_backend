// Phone numbers arrive in many shapes ("078 812 3456", "+250-788-123-456",
// "0788123456"). Orders store them with spaces/dashes/brackets removed so
// staff can find an order by phone however the customer typed it.
const normalizePhone = (value) => {
    if (value === undefined || value === null) return value
    const raw = String(value).trim()
    if (!raw) return null
    // Keep anything that isn't phone-like (e.g. an email in `contact`) untouched.
    if (!/^[+\d(][\d\s().-]*$/.test(raw)) return raw
    return (raw.startsWith('+') ? '+' : '') + raw.replace(/\D/g, '')
}

// The last 9 digits identify a Rwandan mobile number whether it was typed
// as 07xx..., 2507xx... or +2507xx... Returns null for non-phone searches.
const phoneSearchTail = (search) => {
    const text = String(search || '')
    if (/[a-z]/i.test(text)) return null // names, emails, KCL- order codes
    const digits = text.replace(/\D/g, '')
    return digits.length >= 6 ? digits.slice(-9) : null
}

module.exports = { normalizePhone, phoneSearchTail }
