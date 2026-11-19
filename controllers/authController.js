const asyncHandler = require('express-async-handler')
const { hashPassword, verifyPassword } = require('../utils/password')
const jwt = require('jsonwebtoken')
const { prisma } = require('../config/dbConnection')
const { toClientJSON } = require('../utils/transform')
const { defaultPermissions } = require('../utils/permissions')

//To Register a User - public registration always creates a "guest" (client) account.
//Admin/Manager accounts are created from the Admin panel only (see userController.createStaff)
userRegister = asyncHandler(async(req,res)=>{
    const { username, email, password, phone } = req.body
    if (!username || !email || !password){
        res.status(400)
        throw new Error('All fields are mandatory')
    }

    const usernameAvailable = await prisma.user.findUnique({ where: { username } })
    if (usernameAvailable){
        res.status(400)
        throw new Error('UserName Taken')
    }
    const emailAvailable = await prisma.user.findUnique({ where: { email } })
    if (emailAvailable){
        res.status(400)
        throw new Error('Email Taken')
    }
    const hashedPassword = await hashPassword(password)
    const user = await prisma.user.create({
        data: {
            username, email, password: hashedPassword, phone,
            role: 'guest', isAdmin: false, permissions: defaultPermissions,
        },
    })
    const { password: pw, ...others } = user
    res.status(201).json(toClientJSON(others))
})

//To Login using existing Users
loginUser = asyncHandler(async(req,res)=>{
    const { email, password } = req.body
    if (!email || !password){
        res.status(400)
        throw new Error('All fields are mandatory')
    }
    const user = await prisma.user.findUnique({ where: { email } })

    if (!user){
        res.status(400)
        throw new Error('No such User')
    }
    if (user.active === false){
        res.status(403)
        throw new Error('This account has been deactivated. Please contact the Coffee Lab.')
    }
    const { ok, needsRehash } = await verifyPassword(password, user.password)
    if (!ok){
        res.status(400)
        throw new Error('Invalid Password')
    }
    if (needsRehash){
        // one-time upgrade of a legacy AES-encrypted password to bcrypt
        await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(password) } })
    }
    const accessToken = jwt.sign({
        _id: user.id,
        isAdmin: user.isAdmin || user.role === 'admin',
        role: user.role,
        permissions: user.permissions,
    }, process.env.JWT_KEY,{expiresIn: '1d'})

    let cart = await prisma.cart.findUnique({ where: { userId: user.id } })
    if (!cart){
        cart = await prisma.cart.create({ data: { userId: user.id } })
    }

    res.status(200).json(toClientJSON({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin || user.role === 'admin',
        permissions: user.permissions,
        accessToken,
    }))
})

module.exports = { userRegister, loginUser }
