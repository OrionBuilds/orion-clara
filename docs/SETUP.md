# Setting up Clara

Clara runs on your **agent machine** (Linux, or Windows with WSL2) and works inside **Orion** with her own staff account. Set up Orion first: github.com/OrionBuilds/orion.

## 1. Get the code

Clara needs agent-core in the folder next to her:

```bash
mkdir -p ~/agents && cd ~/agents
git clone https://github.com/OrionBuilds/orion-agent-core.git agent-core
git clone https://github.com/OrionBuilds/orion-clara.git clara
cd agent-core && bash scripts/security/check-repo.sh && npm install && cd ..
cd clara && bash scripts/security/check-repo.sh && npm install
```

Both scans must say `no warning signs found` before you install.

## 2. Tell Clara about you and your business

```bash
cp owner-profile.example.json owner-profile.json
cp knowledge/company.example.md knowledge/company.md
```

- **`owner-profile.json`:** your name, time zone, quiet hours, phone numbers and the people who may give Clara instructions.
- **`knowledge/company.md`:** what your business does, who you serve, your services and prices, how you like to work. Clara reads this before she writes anything on your behalf.

Both files stay on your machine and are ignored by git.

## 3. Give Clara her own Orion account

1. Create a mailbox for her on your domain, e.g. `clara@yourbusiness.com` (Google Workspace or Microsoft 365).
2. In Orion go to **Settings → Organization → Staff Management → Invite User**, enter that address, and give it the **ClaraAgent** role.
3. Accept the invite from Clara's mailbox.

## 4. Fill in her settings

```bash
cp .env.example .env.local
```

Fill in at least the three **Required** sections: the Orion connection, who Clara works for, and AI. Add Google or Microsoft details for her mailbox and calendar. Everything else is optional and can wait.

`INTERAGENT_SHARED_SECRET` must be the same value in Clara, FRIDAY and Orion.

## 5. Start Clara

```bash
npm run build
npm start          # http://127.0.0.1:3939
```

Clara only listens on `127.0.0.1`: she isn't reachable from the internet unless you deliberately put something in front of her (step 8).

## 6. Sign Clara in to Orion

Both sign-ins use **Clara's account**, never yours. Do them in a **private browser window**, so your own login isn't reused:

1. Open `http://127.0.0.1:3939/api/os/auth` and sign in as Clara. This connects her CRM tools.
2. Open `http://127.0.0.1:3939/os/auth/agent` and sign in as Clara again. This connects her scheduled tasks.

**Don't sign Clara out of Orion in that browser afterwards.** Signing out revokes the session she just captured. More detail: [os-agent-auth.md](os-agent-auth.md).

## 7. Run her as a service (Linux / WSL2)

Create `~/.config/systemd/user/clara.service`:

```ini
[Unit]
Description=Clara
After=network-online.target

[Service]
WorkingDirectory=%h/agents/clara
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clara
journalctl --user -u clara -f
```

If Node came from nvm, `npm` may not be on the service's path: replace `ExecStart` with the full path that `which npm` prints.

## 8. Phone and SMS (optional)

Twilio has to reach Clara over HTTPS, so put a tunnel or reverse proxy in front of `127.0.0.1:3939` (for example Cloudflare Tunnel, with Cloudflare Access protecting everything except the webhook paths). Then:

1. Set `CLARA_PUBLIC_WEBHOOK_BASE` to that public HTTPS address.
2. In Twilio, point your number's voice and messaging webhooks at the addresses under `/api/channels/twilio/` on that base.
3. Keep `TWILIO_ENFORCE_SIGNATURE=true`, so only genuine Twilio requests are accepted.

The work line, putting callers through and the owner morning call are described in [work-line.md](work-line.md).

## 9. Check she's alive

- Orion's **Agent Health** page shows Clara's heartbeat and costs.
- Clara's own dashboard at `http://127.0.0.1:3939` shows her inbox, approvals, calendar and logs.

## Updating

```bash
cd ~/agents/agent-core && git pull && bash scripts/security/check-repo.sh && npm install
cd ~/agents/clara && git pull && bash scripts/security/check-repo.sh && npm install && npm run build
systemctl --user restart clara
```

Never build an update the scanner flags.
