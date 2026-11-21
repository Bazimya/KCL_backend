// pm2 process file for Kigali Coffee Lab on the VPS (run as the `kcl` user):
//   pm2 startOrReload deploy/ecosystem.config.js && pm2 save
// Secrets are NOT here - the API reads them from KCL_backend/.env (chmod 600),
// which is created on the server and never committed.
//
// Both processes listen on KCL_BIND_HOST (default 172.17.0.1, the Docker
// bridge) so only the reverse proxy (Caddy in Docker) can reach them - not
// the public internet.
const path = require('path')

const bindHost = process.env.KCL_BIND_HOST || '172.17.0.1'
const backendDir = path.join(__dirname, '..')

module.exports = {
    apps: [
        {
            name: 'kcl-api',
            script: 'server.js',
            cwd: backendDir,
            instances: 1, // uploads + in-process rate limiter assume a single process
            exec_mode: 'fork',
            env: { NODE_ENV: 'production', HOST: bindHost },
            max_memory_restart: '400M',
            time: true,
            out_file: '/var/log/kcl/api.out.log',
            error_file: '/var/log/kcl/api.err.log',
        },
        {
            name: 'kcl-web',
            script: 'deploy/static-server.js',
            cwd: backendDir,
            instances: 1,
            exec_mode: 'fork',
            env: {
                NODE_ENV: 'production',
                HOST: bindHost,
                WEB_PORT: '5051',
                WEB_ROOT: path.join(backendDir, '..', 'KCL_frontend', 'dist'),
            },
            max_memory_restart: '150M',
            time: true,
            out_file: '/var/log/kcl/web.out.log',
            error_file: '/var/log/kcl/web.err.log',
        },
    ],
}
