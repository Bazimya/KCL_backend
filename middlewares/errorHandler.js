const notFound = (req,res,next)=>{
    const error =  new Error(`Not Found: ${req.originalUrl}`)
    res.status(404)
    next(error)
}

const errorHandler = (err,req,res,next)=>{
    const statusCode = res.statusCode == 200 ? 500 : res.statusCode
    res.status(statusCode)
    if (statusCode >= 500) console.error(err)
    const message = statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err?.message || 'Internal server error'
    const response = { msg: message }
    if (process.env.NODE_ENV !== 'production') response.stack = err?.stack
    res.json(response)
}

module.exports = { notFound, errorHandler }