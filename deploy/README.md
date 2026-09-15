# Putting this server on a new machine

Everything here exists because it went wrong once on the test box. Work down
the list; each step ends with a command that proves it.

Assumes Ubuntu, node 20+, and a domain already pointed at the machine.

---

## 1. The code

```bash
git clone <this repo> ~/cosmosgen-backend
cd ~/cosmosgen-backend
npm ci
```

`npm ci` rather than `npm install` - it installs exactly what
`package-lock.json` pins, so the server runs the versions that were tested.
That file is committed for this reason; do not add it to `.gitignore`.

## 2. The environment

```bash
cp .env.example .env
nano .env
```

Fill in every blank. Three are worth saying out loud:

- **`NODE_ENV=production`** - decides the auth cookie's flags. Wrong here and
  login succeeds, then everything after it is 401.
- **`CLIENT_ORIGINS`** - the website's address **first** in the list. It is the
  CORS allow-list *and* the base of the tracking link sent to customers on
  WhatsApp, and the link is built from the first entry. With localhost first,
  every customer gets a link that opens nothing.
- **`PUBLIC_API_URL`** - this server's own address, for the provider consoles.

## 3. nginx

```bash
sudo apt install -y nginx
sudo cp deploy/nginx-upgrade-map.conf.example /etc/nginx/conf.d/upgrade-map.conf
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/cosmosgen-backend
sudo ln -sf /etc/nginx/sites-available/cosmosgen-backend /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nano /etc/nginx/sites-available/cosmosgen-backend   # set server_name
sudo nginx -t && sudo systemctl reload nginx
```

Removing the `default` site is not tidiness. With it enabled a directive put
in the wrong file lands in a server block that never serves this domain, and
nginx reports no error at all - it simply ignores you.

## 4. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

Certbot edits the site file in place and adds the 443 block. Re-check
afterwards that `client_max_body_size` is still inside the block it rewrote.

## 5. Run it

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # then run the line it prints
```

After any `.env` edit: `pm2 restart all --update-env`. Without `--update-env`
pm2 hands the old environment straight back and the file looks ignored.

## 6. Elsewhere

- **MongoDB Atlas** - allow this machine's IP under Network Access.
- **Meta** - webhook to `https://<api>/api/webhook/whatsapp`, verify token from
  `.env`. A test number only delivers to numbers on its allow-list, and
  free-form text only inside 24 hours of the customer's last message - real
  vendors need a verified number and an authentication template.
- **Exotel** - Flow applet URLs and StatusCallback to `https://<api>/api/voice/...`
- **Razorpay** - webhook to `https://<api>/api/webhook/razorpay`

---

## Proving it works

```bash
API=https://api.example.com

# up, and talking to Mongo
curl -s -o /dev/null -w "root      %{http_code}\n" $API/
curl -s -o /dev/null -w "services  %{http_code}\n" $API/api/customer/services

# the cookie carries across sites - Secure and SameSite=None, or sessions die
curl -si -X POST $API/api/customer/logout | grep -i set-cookie

# uploads: under 3 MB reaches the app, over it is refused in words, and only
# something enormous is stopped by nginx
head -c 2500000 /dev/urandom > /tmp/a.bin
curl -s -X POST $API/api/technician/register -F phoneToken=x -F profileImage=@/tmp/a.bin\;type=image/jpeg
rm /tmp/a.bin
```

Expected: `200`, `200`, a cookie reading `Secure; SameSite=None`, and a JSON
body - never an HTML page. An HTML error page means nginx answered instead of
the application, and the apps cannot read a message out of one.

## Frontend

The site is a static build with client-side routing, so its host must send
every unknown path to `index.html` or a refresh on `/account` is a 404.

- **Apache / Hostinger** - `frontend/deploy/.htaccess`, copied next to the build
- **Amplify** - console rule, source `</^[^.]+$|\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>`, target `/index.html`, type **200 (Rewrite)** - not the 404 rewrite it offers by default
- **Netlify** - `frontend/public/_redirects`, already in the repo

Build-time variables (`VITE_API_URL`, `VITE_SOCKET_URL`) are baked into the
bundle, so changing them needs a rebuild, not a restart.

### Same domain, if you can

Cookies are the one thing that gets easier when the site and the API share a
registrable domain - `app.example.com` and `api.example.com`. Then the session
cookie is first-party, no browser or extension can refuse it as third-party
tracking, and CORS stops applying at all. On split hosts the alternative is to
proxy `/api` and `/socket.io` through the frontend's own origin.
