const {
    getTables, getTable, createTable, updateTable, deleteTable, downloadTableQr, getTableByQr,
    createBooking, getBookings, updateBooking, getAvailability,
} = require('../controllers/tableController')
const { StaffAuth } = require('../middlewares/validateTokenHandler')
const router = require('express').Router()

// Public - so the app can show customers a table picker, and so a scanned
// QR code resolves to its table (before any table-id routes below, so
// "scan"/"bookings" never get swallowed by the :id route).
router.get('/scan/:qrToken', getTableByQr)

router.get('/availability', getAvailability)
router.post('/bookings', createBooking)
router.get('/bookings', StaffAuth('manageTables'), getBookings)
router.put('/bookings/:id', StaffAuth('manageTables'), updateBooking)

router.get('/', getTables)
router.get('/:id', getTable)
router.get('/:id/qr', StaffAuth('manageTables'), downloadTableQr)

// Staff only (manageTables). Customers pick their table by scanning its QR
// sticker, so they never need to create one.
router.post('/', StaffAuth('manageTables'), createTable)
router.put('/:id', StaffAuth('manageTables'), updateTable)
router.delete('/:id', StaffAuth('manageTables'), deleteTable)

module.exports = router
