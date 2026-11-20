// Table reservation rules - one place for everything that decides whether a
// table can be booked, or ordered at, at a given time. Used by:
//   - createBooking / updateBooking   (tableController.js)
//   - the public availability check   (GET /tables/availability)
//   - QR scan + dine-in orders         (getTableByQr, orderController.createOrder)
const { Prisma } = require('@prisma/client')

const RULES = {
    // Online booking hours, Kigali time: a reservation must start at or
    // after OPENING_HOUR and finish by CLOSING_HOUR (21 = 9:00 PM).
    OPENING_HOUR: 7,
    CLOSING_HOUR: 21,
    MIN_DURATION_MINUTES: 30,
    MAX_DURATION_MINUTES: 240,
    // A table needs a short gap between two reservations to be cleared and reset.
    TURNOVER_BUFFER_MINUTES: 15,
    // How far ahead, and how close to "now", a customer may book online.
    MIN_LEAD_MINUTES: 15,
    MAX_ADVANCE_DAYS: 60,
    MAX_PARTY_SIZE: 50,
    // One phone number can't hold more than this many upcoming reservations.
    MAX_UPCOMING_PER_PHONE: 3,
    // Walk-in QR orders are refused this long before a reservation starts...
    BLOCK_WINDOW_MINUTES: 30,
    // ...and the customer is warned from this long before.
    WARN_WINDOW_MINUTES: 60,
    // A reservation still "Upcoming" this long after its start (the party
    // never arrived and staff didn't mark it Active) stops blocking walk-ins.
    NO_SHOW_GRACE_MINUTES: 20,
}

const LIVE_STATUSES = ['Upcoming', 'Active']
const ALL_STATUSES = ['Upcoming', 'Active', 'Completed', 'Cancelled']
// Orders at a table keep it occupied until one of these.
const TERMINAL_ORDER_STATUSES = ['Served', 'Cancelled']

const minutes = (n) => n * 60000

// Minutes since midnight in Kigali (UTC+2, no daylight saving) for a Date.
const kigaliMinuteOfDay = (date) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
    const get = (type) => Number(parts.find((p) => p.type === type).value)
    return get('hour') * 60 + get('minute')
}
const hourLabel = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`
const openingHoursText = () => `${hourLabel(RULES.OPENING_HOUR)} to ${hourLabel(RULES.CLOSING_HOUR)}`
const bookingEnd = (b) => new Date(new Date(b.startTime).getTime() + minutes(b.durationMinutes))

class BookingRuleError extends Error {
    constructor(message, status = 400) { super(message); this.status = status }
}

// Shape checks for a requested reservation. `forStaff` relaxes the
// customer-only limits (lead time, how far ahead, opening hours) when staff
// edit a booking; `enforceHours` turns the opening-hours check back on.
const validateRequest = ({ start, durationMinutes, partySize, forStaff = false, enforceHours = !forStaff }) => {
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new BookingRuleError('Please choose a valid date and time')
    const now = Date.now()
    if (start.getTime() < now - (forStaff ? minutes(24 * 60) : 0)) throw new BookingRuleError('Please choose a time in the future')
    if (!forStaff) {
        if (start.getTime() < now + minutes(RULES.MIN_LEAD_MINUTES)) {
            throw new BookingRuleError(`Online bookings need at least ${RULES.MIN_LEAD_MINUTES} minutes' notice. For a table right now, just come in and scan its QR code.`)
        }
        if (start.getTime() > now + minutes(RULES.MAX_ADVANCE_DAYS * 24 * 60)) {
            throw new BookingRuleError(`Bookings can be made up to ${RULES.MAX_ADVANCE_DAYS} days ahead`)
        }
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < RULES.MIN_DURATION_MINUTES || durationMinutes > RULES.MAX_DURATION_MINUTES) {
        throw new BookingRuleError(`A booking must last between ${RULES.MIN_DURATION_MINUTES} minutes and ${RULES.MAX_DURATION_MINUTES / 60} hours`)
    }
    if (enforceHours) {
        const startMin = kigaliMinuteOfDay(start)
        const endMin = startMin + durationMinutes
        if (startMin < RULES.OPENING_HOUR * 60 || endMin > RULES.CLOSING_HOUR * 60) {
            const latestStart = RULES.CLOSING_HOUR * 60 - durationMinutes
            const latest = `${((Math.floor(latestStart / 60) + 11) % 12) + 1}:${String(latestStart % 60).padStart(2, '0')} ${latestStart < 720 ? 'AM' : 'PM'}`
            throw new BookingRuleError(`We take bookings from ${openingHoursText()} (Kigali time). For ${durationMinutes} minutes, the latest start is ${latest}.`)
        }
    }
    if (partySize !== undefined && (!Number.isInteger(partySize) || partySize < 1 || partySize > RULES.MAX_PARTY_SIZE)) {
        throw new BookingRuleError(`Party size must be between 1 and ${RULES.MAX_PARTY_SIZE}. For bigger groups please call us.`)
    }
}

// Inside a transaction: lock the chosen table rows so two people booking the
// same table at the same moment are handled one after the other - the second
// one then sees the first booking and gets a clear "already booked" answer.
const lockTables = (tx, tableIds) =>
    tx.$queryRaw`SELECT id FROM tables WHERE id IN (${Prisma.join(tableIds)}) FOR UPDATE`

// Live reservations on these tables whose time (plus the turnover buffer)
// overlaps [start, end). Returns [{ booking, tableIds: [...] }].
const findBookingConflicts = async (db, tableIds, start, end, excludeBookingId = null) => {
    const buffer = minutes(RULES.TURNOVER_BUFFER_MINUTES)
    const links = await db.tableBookingTable.findMany({
        where: {
            tableId: { in: tableIds },
            booking: {
                status: { in: LIVE_STATUSES },
                startTime: { lt: new Date(end.getTime() + buffer) },
                ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
            },
        },
        include: { booking: true },
    })
    const byBooking = new Map()
    for (const link of links) {
        if (bookingEnd(link.booking).getTime() + buffer <= start.getTime()) continue
        const entry = byBooking.get(link.booking.id) || { booking: link.booking, tableIds: [] }
        entry.tableIds.push(link.tableId)
        byBooking.set(link.booking.id, entry)
    }
    return [...byBooking.values()]
}

// Tables with a dine-in order still in progress right now.
const tablesInUse = async (db, tableIds) => {
    const orders = await db.order.findMany({
        where: { tableId: { in: tableIds }, orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
        select: { tableId: true },
    })
    return new Set(orders.map((o) => o.tableId))
}

// Is a reservation still holding its table at `now`? (Not finished, and not
// an "Upcoming" no-show past the grace period.)
const isBookingHoldingTable = (booking, now = new Date()) => {
    if (!LIVE_STATUSES.includes(booking.status)) return false
    const start = new Date(booking.startTime)
    if (bookingEnd(booking) <= now) return false
    if (booking.status === 'Upcoming' && now.getTime() > start.getTime() + minutes(RULES.NO_SHOW_GRACE_MINUTES)) return false
    return true
}

// The reservation a QR scan / walk-in order at this table should know about:
// the next one starting within the warning window that still holds the table.
const nextBookingForWalkIn = async (db, tableId, now = new Date()) => {
    const links = await db.tableBookingTable.findMany({
        where: {
            tableId,
            booking: { status: { in: LIVE_STATUSES }, startTime: { lte: new Date(now.getTime() + minutes(RULES.WARN_WINDOW_MINUTES)) } },
        },
        include: { booking: true },
        orderBy: { booking: { startTime: 'asc' } },
    })
    const live = links.map((l) => l.booking).find((b) => isBookingHoldingTable(b, now))
    if (!live) return null
    const start = new Date(live.startTime)
    const isNow = start <= now
    const minutesUntilStart = Math.max(0, Math.round((start - now) / 60000))
    return { ...live, isNow, minutesUntilStart, blocked: isNow || minutesUntilStart <= RULES.BLOCK_WINDOW_MINUTES }
}

const describeConflict = (conflicts, tables) => {
    const labels = new Map(tables.map((t) => [t.id, t.label]))
    const busy = [...new Set(conflicts.flatMap((c) => c.tableIds))].map((id) => labels.get(id) || `Table ${id}`)
    return `${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} already booked around that time. ` +
        'Please choose another table or time - the booking page shows which tables are free.'
}

module.exports = {
    RULES, LIVE_STATUSES, ALL_STATUSES, BookingRuleError, bookingEnd, kigaliMinuteOfDay,
    validateRequest, lockTables, findBookingConflicts, tablesInUse,
    isBookingHoldingTable, nextBookingForWalkIn, describeConflict,
}
