const asyncHandler = require('express-async-handler')
const { notifySms, kigaliTime } = require('../utils/sms')
const { prisma } = require('../config/dbConnection')
const { toClientJSON } = require('../utils/transform')
const { getPagination, buildPageResult } = require('../utils/paginate')
const { toNumber, toBool } = require('../utils/coerce')
const { generateTableStickerPng } = require('../utils/qrcode')
const { normalizePhone } = require('../utils/phone')
const { toE164 } = require('../utils/sms')
const {
    RULES, LIVE_STATUSES, ALL_STATUSES, BookingRuleError, bookingEnd,
    validateRequest, lockTables, findBookingConflicts, tablesInUse,
    nextBookingForWalkIn, describeConflict,
} = require('../utils/bookingRules')

// Orders at a table are always dine_in (the only type that ever has a
// tableId). An order "occupies" its table until it reaches one of these -
// everything else (Order Placed, Preparing, Ready for Pickup) still blocks
// a fresh order from starting at the same table.
const TERMINAL_TABLE_STATUSES = ['Served', 'Cancelled']

// Public - active tables only, so the app can show a table picker when a
// customer places a dine-in coffee/food order.
// ?all=true (staff only in practice, but not enforced here) also returns
// hidden/inactive tables for the admin dashboard's table manager.
getTables = asyncHandler(async (req, res) => {
    const { all } = req.query
    const where = all ? {} : { active: true }
    const tables = await prisma.table.findMany({ where, orderBy: { label: 'asc' } })
    res.status(200).json(toClientJSON(tables))
})

getTable = asyncHandler(async (req, res) => {
    const table = await prisma.table.findUnique({ where: { id: Number(req.params.id) } })
    if (!table) { res.status(404); throw new Error('Table not found') }
    res.status(200).json(toClientJSON(table))
})

// Admin / permitted Manager (manageTables) - add a table, e.g. "Table 1".
// A qrToken is generated automatically (see schema.prisma) the moment the
// row is created - nothing extra to do here.
createTable = asyncHandler(async (req, res) => {
    const { label, capacity, active } = req.body
    if (!label) {
        res.status(400)
        throw new Error('Table label is mandatory (e.g. "Table 1")')
    }
    const existing = await prisma.table.findUnique({ where: { label } })
    if (existing) {
        res.status(400)
        throw new Error('A table with that label already exists')
    }
    const table = await prisma.table.create({
        data: { label, capacity: toNumber(capacity), active: active === undefined ? undefined : toBool(active) },
    })
    res.status(201).json(toClientJSON(table))
})

// Live reservations on a table that haven't finished yet.
const upcomingBookingsFor = async (tableId) => {
    const links = await prisma.tableBookingTable.findMany({
        where: { tableId, booking: { status: { in: LIVE_STATUSES } } },
        include: { booking: true },
    })
    const now = new Date()
    return links.filter((l) => bookingEnd(l.booking) > now).length
}

updateTable = asyncHandler(async (req, res) => {
    const table = await prisma.table.findUnique({ where: { id: Number(req.params.id) } })
    if (!table) { res.status(404); throw new Error('Table not found') }
    const { label, capacity, active } = req.body
    const data = {}
    if (label !== undefined) data.label = label
    if (capacity !== undefined) data.capacity = toNumber(capacity)
    if (active !== undefined) data.active = toBool(active)
    if (data.active === false && table.active) {
        const upcoming = await upcomingBookingsFor(table.id)
        if (upcoming) {
            res.status(409)
            throw new Error(`${table.label} has ${upcoming} upcoming booking${upcoming > 1 ? 's' : ''}. Move or cancel ${upcoming > 1 ? 'them' : 'it'} before hiding the table.`)
        }
    }
    const updated = await prisma.table.update({ where: { id: table.id }, data })
    res.status(200).json(toClientJSON(updated))
})

deleteTable = asyncHandler(async (req, res) => {
    const table = await prisma.table.findUnique({ where: { id: Number(req.params.id) } })
    if (!table) { res.status(404); throw new Error('Table not found') }
    const upcoming = await upcomingBookingsFor(table.id)
    if (upcoming) {
        res.status(409)
        throw new Error(`${table.label} has ${upcoming} upcoming booking${upcoming > 1 ? 's' : ''}. Move or cancel ${upcoming > 1 ? 'them' : 'it'} before deleting the table.`)
    }
    if ((await tablesInUse(prisma, [table.id])).size) {
        res.status(409)
        throw new Error(`${table.label} has an order in progress. Finish or cancel it before deleting the table.`)
    }
    await prisma.table.delete({ where: { id: table.id } })
    res.status(200).json({ msg: 'deleted' })
})

// Staff (manageTables) - the full printable sticker PNG: "Welcome to Kigali
// Coffee Lab" / the table's name up top, the QR (with the KCL logo
// composited into its center) in the middle, a short caption below.
downloadTableQr = asyncHandler(async (req, res) => {
    const table = await prisma.table.findUnique({ where: { id: Number(req.params.id) } })
    if (!table) { res.status(404); throw new Error('Table not found') }
    const png = await generateTableStickerPng(table)
    res.set('Content-Type', 'image/png')
    res.set('Content-Disposition', `attachment; filename="${table.label.replace(/\s+/g, '-')}-qr.png"`)
    res.send(png)
})

// Public - what a phone camera actually opens when it scans the sticker.
// Tells the frontend whether this table is free to order at right now, has
// a pending order it should resume tracking instead, and whether a
// reservation is starting soon it should warn the customer about.
getTableByQr = asyncHandler(async (req, res) => {
    const table = await prisma.table.findUnique({ where: { qrToken: req.params.qrToken } })
    if (!table || !table.active) {
        res.status(404)
        throw new Error('This table QR code is not recognised. Please ask a staff member for help.')
    }

    const activeOrder = await prisma.order.findFirst({
        where: { tableId: table.id, orderStatus: { notIn: TERMINAL_TABLE_STATUSES } },
        include: { products: true },
        orderBy: { createdAt: 'desc' },
    })

    const upcomingBooking = await nextBookingForWalkIn(prisma, table.id)

    res.status(200).json(toClientJSON({ table, activeOrder, upcomingBooking }))
})

// ---------------- Table Bookings / Reservations ----------------

// Turns a BookingRuleError thrown inside a transaction into its HTTP status.
const withRuleStatus = async (res, fn) => {
    try { return await fn() } catch (err) {
        if (err instanceof BookingRuleError) res.status(err.status)
        throw err
    }
}

// Public - which active tables are free for a requested time slot, so the
// booking page can grey out taken tables before the customer submits.
// Reveals nothing about who booked them.
getAvailability = asyncHandler(async (req, res) => {
    const start = new Date(req.query.start)
    const durationMinutes = toNumber(req.query.duration) || 60
    await withRuleStatus(res, async () => validateRequest({ start, durationMinutes, forStaff: true, enforceHours: true }))
    const end = new Date(start.getTime() + durationMinutes * 60000)
    const tables = await prisma.table.findMany({ where: { active: true }, orderBy: { label: 'asc' } })
    const ids = tables.map((t) => t.id)
    const booked = new Set((await findBookingConflicts(prisma, ids, start, end)).flatMap((c) => c.tableIds))
    const startsSoon = start.getTime() - Date.now() <= RULES.BLOCK_WINDOW_MINUTES * 60000
    const inUse = startsSoon ? await tablesInUse(prisma, ids) : new Set()
    res.status(200).json(toClientJSON({
        tables: tables.map((t) => ({
            ...t,
            available: !booked.has(t.id) && !inUse.has(t.id),
            reason: booked.has(t.id) ? 'booked' : inUse.has(t.id) ? 'in_use' : null,
        })),
        rules: {
            openingHour: RULES.OPENING_HOUR,
            closingHour: RULES.CLOSING_HOUR,
            minLeadMinutes: RULES.MIN_LEAD_MINUTES,
            maxAdvanceDays: RULES.MAX_ADVANCE_DAYS,
            minDurationMinutes: RULES.MIN_DURATION_MINUTES,
            maxDurationMinutes: RULES.MAX_DURATION_MINUTES,
            turnoverBufferMinutes: RULES.TURNOVER_BUFFER_MINUTES,
            maxPartySize: RULES.MAX_PARTY_SIZE,
        },
    }))
})

// Public - anyone can reserve a table (or several) ahead of time, same
// guest-friendly pattern as placing an order: no account needed. Every rule
// lives in utils/bookingRules.js; the chosen tables are locked while we
// check, so two people booking the same table at once can't both succeed.
createBooking = asyncHandler(async (req, res) => {
    const { tableIds, customerName, notes } = req.body
    const customerPhone = normalizePhone(req.body.customerPhone)
    const ids = [...new Set((Array.isArray(tableIds) ? tableIds : [tableIds]).map(Number))].filter(Boolean)
    if (!ids.length) {
        res.status(400)
        throw new Error('Please choose at least one table')
    }
    if (!customerName?.trim() || !customerPhone || !req.body.startTime) {
        res.status(400)
        throw new Error('Name, phone and reservation time are mandatory')
    }
    if (!toE164(customerPhone)) {
        res.status(400)
        throw new Error('Please enter a valid phone number (e.g. 078 123 4567) so we can confirm your booking')
    }
    const start = new Date(req.body.startTime)
    const duration = toNumber(req.body.durationMinutes) || 60
    const partySize = toNumber(req.body.partySize) || 1

    const booking = await withRuleStatus(res, async () => {
        validateRequest({ start, durationMinutes: duration, partySize })
        const end = new Date(start.getTime() + duration * 60000)
        return prisma.$transaction(async (tx) => {
            await lockTables(tx, ids)
            const tables = await tx.table.findMany({ where: { id: { in: ids }, active: true } })
            if (tables.length !== ids.length) throw new BookingRuleError('One or more selected tables are not available')

            const seats = tables.reduce((sum, t) => sum + t.capacity, 0)
            if (seats < partySize) {
                throw new BookingRuleError(`${tables.length > 1 ? 'Those tables seat' : 'That table seats'} ${seats}, but your party is ${partySize}. Please add another table.`)
            }

            const conflicts = await findBookingConflicts(tx, ids, start, end)
            if (conflicts.length) throw new BookingRuleError(describeConflict(conflicts, tables), 409)

            if (start.getTime() - Date.now() <= RULES.BLOCK_WINDOW_MINUTES * 60000) {
                const busy = await tablesInUse(tx, ids)
                if (busy.size) {
                    const labels = tables.filter((t) => busy.has(t.id)).map((t) => t.label).join(', ')
                    throw new BookingRuleError(`${labels} ${busy.size > 1 ? 'are' : 'is'} in use right now. Please pick another table or a later time.`, 409)
                }
            }

            // Same phone: no overlapping double-booking, and a cap on how many
            // upcoming reservations one number can hold.
            const now = new Date()
            const mine = (await tx.tableBooking.findMany({ where: { customerPhone, status: { in: LIVE_STATUSES } } }))
                .filter((b) => bookingEnd(b) > now)
            const clash = mine.find((b) => new Date(b.startTime) < end && bookingEnd(b) > start)
            if (clash) throw new BookingRuleError(`You already have a booking at that time (ref B-${clash.id}). Call us if you need to change it.`, 409)
            if (mine.length >= RULES.MAX_UPCOMING_PER_PHONE) {
                throw new BookingRuleError(`This phone number already has ${mine.length} upcoming bookings. Please call us to book more.`, 409)
            }

            return tx.tableBooking.create({
                data: {
                    customerName: customerName.trim(), customerPhone,
                    partySize,
                    startTime: start,
                    durationMinutes: duration,
                    notes,
                    tables: { create: ids.map((tableId) => ({ tableId })) },
                },
                include: { tables: { include: { table: true } } },
            })
        })
    })

    notifySms(customerPhone,
        `Kigali Coffee Lab: your table booking (ref B-${booking.id}) is received for ` +
        `${kigaliTime(booking.startTime)}, ${booking.tables.map((t) => t.table.label).join(', ')}, ` +
        `party of ${booking.partySize}. See you soon!`)
    res.status(201).json(toClientJSON(booking))
})

// Staff (manageTables) - paginated/searchable/filterable booking list
getBookings = asyncHandler(async (req, res) => {
    const { search, status, page: pageQ, limit: limitQ } = req.query
    const where = {}
    if (status) where.status = status
    if (search) {
        where.OR = [
            { customerName: { contains: search } },
            { customerPhone: { contains: search } },
        ]
    }
    const include = { tables: { include: { table: true } } }

    if (!pageQ && !limitQ) {
        const bookings = await prisma.tableBooking.findMany({ where, include, orderBy: { startTime: 'asc' } })
        return res.status(200).json(toClientJSON(bookings))
    }
    const { page, limit, offset } = getPagination(req.query, 10)
    const [rows, count] = await Promise.all([
        prisma.tableBooking.findMany({ where, include, orderBy: { startTime: 'asc' }, take: limit, skip: offset }),
        prisma.tableBooking.count({ where }),
    ])
    res.status(200).json(toClientJSON(buildPageResult({ rows, count }, page, limit)))
})

// Staff (manageTables) - change status, time, length, party size or notes.
// Moving a booking, or reviving a cancelled/completed one, is re-checked
// against the other bookings on its tables.
updateBooking = asyncHandler(async (req, res) => {
    const booking = await prisma.tableBooking.findUnique({
        where: { id: Number(req.params.id) },
        include: { tables: { include: { table: true } } },
    })
    if (!booking) { res.status(404); throw new Error('Booking not found') }
    const { status, startTime, durationMinutes, partySize, notes } = req.body
    if (status !== undefined && !ALL_STATUSES.includes(status)) {
        res.status(400)
        throw new Error(`Status must be one of: ${ALL_STATUSES.join(', ')}`)
    }

    const data = {}
    if (status !== undefined) data.status = status
    if (startTime !== undefined) data.startTime = new Date(startTime)
    if (durationMinutes !== undefined) data.durationMinutes = toNumber(durationMinutes)
    if (partySize !== undefined) data.partySize = toNumber(partySize)
    if (notes !== undefined) data.notes = notes

    const next = { ...booking, ...data }
    const timeChanged = startTime !== undefined || durationMinutes !== undefined
    const revived = LIVE_STATUSES.includes(next.status) && !LIVE_STATUSES.includes(booking.status)
    const tableIds = booking.tables.map((t) => t.tableId)

    const updated = await withRuleStatus(res, async () => {
        if (timeChanged) validateRequest({ start: new Date(next.startTime), durationMinutes: next.durationMinutes, forStaff: true })
        if (partySize !== undefined) validateRequest({ start: new Date(next.startTime), durationMinutes: next.durationMinutes, partySize: next.partySize, forStaff: true })
        return prisma.$transaction(async (tx) => {
            if ((timeChanged || revived) && LIVE_STATUSES.includes(next.status) && tableIds.length) {
                await lockTables(tx, tableIds)
                const start = new Date(next.startTime)
                const end = new Date(start.getTime() + next.durationMinutes * 60000)
                const conflicts = await findBookingConflicts(tx, tableIds, start, end, booking.id)
                if (conflicts.length) {
                    const refs = conflicts.map((c) => `B-${c.booking.id}`).join(', ')
                    throw new BookingRuleError(`${describeConflict(conflicts, booking.tables.map((t) => t.table)).split('.')[0]} (booking ${refs}).`, 409)
                }
            }
            return tx.tableBooking.update({
                where: { id: booking.id }, data,
                include: { tables: { include: { table: true } } },
            })
        })
    })

    if (data.status === 'Cancelled' && booking.status !== 'Cancelled') {
        notifySms(booking.customerPhone,
            `Kigali Coffee Lab: your table booking (ref B-${booking.id}) for ${kigaliTime(booking.startTime)} ` +
            `has been cancelled. Please call us to rebook.`)
    } else if (data.startTime && new Date(data.startTime).getTime() !== new Date(booking.startTime).getTime()) {
        notifySms(booking.customerPhone,
            `Kigali Coffee Lab: your table booking (ref B-${booking.id}) has moved to ${kigaliTime(updated.startTime)}.`)
    }
    res.status(200).json(toClientJSON(updated))
})

module.exports = {
    getTables, getTable, createTable, updateTable, deleteTable, downloadTableQr, getTableByQr,
    createBooking, getBookings, updateBooking, getAvailability,
}
