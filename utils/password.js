const bcrypt = require('bcryptjs')
const CryptoJS = require('crypto-js')

// Passwords are stored as one-way bcrypt hashes. Accounts created before the
// switch still hold the old reversible AES ciphertext (encrypted with
// PASSWORD_KEY); those are verified the old way once and then re-hashed with
// bcrypt on that successful login (see authController.loginUser), so
// PASSWORD_KEY is only needed until every legacy account has logged in again.
const BCRYPT_ROUNDS = 12
const isBcryptHash = (stored) => /^\$2[aby]\$\d{2}\$/.test(stored || '')

const hashPassword = (plain) => bcrypt.hash(String(plain), BCRYPT_ROUNDS)

// Returns { ok, needsRehash }
const verifyPassword = async (plain, stored) => {
    if (!stored) return { ok: false, needsRehash: false }
    if (isBcryptHash(stored)) {
        return { ok: await bcrypt.compare(String(plain), stored), needsRehash: false }
    }
    if (!process.env.PASSWORD_KEY) return { ok: false, needsRehash: false }
    let decrypted = ''
    try {
        decrypted = CryptoJS.AES.decrypt(stored, process.env.PASSWORD_KEY).toString(CryptoJS.enc.Utf8)
    } catch {
        return { ok: false, needsRehash: false }
    }
    const ok = decrypted !== '' && decrypted === String(plain)
    return { ok, needsRehash: ok }
}

module.exports = { hashPassword, verifyPassword, isBcryptHash }
