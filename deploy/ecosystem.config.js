// pm2 process file for the KCL API on the VPS.
//   pm2 startOrReload deploy/ecosystem.config.js && pm2 save
// Secrets are NOT here - the API reads them from KCL_backend/.env (chmod 600),
// which deploy/setup-vps.sh generates on the server.
const path = require('path')

module.exports = {
    apps: [
        {
            name: 'kcl-api',
            script: 'server.js',
            cwd: path.join(__dirname, '..'),
            instances: 1, // uploads + in-process rate limiter assume a single process
            exec_mode: 'fork',
            env: { NODE_ENV: 'production' },
            max_memory_restart: '400M',
            time: true,
            out_file: '/var/log/kcl/api.out.log',
            error_file: '/var/log/kcl/api.err.log',
        },
    ],
}
