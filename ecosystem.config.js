/**
 * How pm2 should run this server.
 *
 * Kept in the repo so a new machine gets the same process every time:
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save          # survive a reboot
 *   pm2 startup       # and run whatever that prints, once
 *
 * The one line that matters most is NODE_ENV. It decides the auth cookie's
 * flags: `production` sends Secure + SameSite=None, which is the only way a
 * browser carries the session from the website to this API when the two are
 * on different hosts. Left at `development` the login succeeds, the cookie is
 * dropped, and every request after it comes back 401 - which reads like a
 * broken password rather than a misconfigured server.
 *
 * Setting it here rather than in .env is deliberate. `dotenv` never overwrites
 * a variable that is already in the environment, so a value pm2 is holding
 * wins over the file no matter how many times the file is corrected. Putting
 * it where pm2 itself reads it removes that argument. For the same reason,
 * after editing .env restart with `pm2 restart all --update-env` - a plain
 * restart hands the old environment straight back.
 */
module.exports = {
    apps: [
        {
            name: "cosmosgen",
            script: "server.js",
            instances: 1,

            // Single instance on purpose. socket.io holds connections in this
            // process's memory, so a second worker would answer with a room
            // it has never heard of. Clustering needs a shared adapter first.
            exec_mode: "fork",

            env: {
                NODE_ENV: "production",
            },

            max_memory_restart: "500M",
            time: true,            // timestamps in pm2 logs
            merge_logs: true,
        },
    ],
};
