# Clara

Clara is an open-source AI executive assistant for business owners. She reads and triages your inbox, keeps your calendar, prepares briefings, drafts replies and follow-ups, answers and makes phone calls, and works through your business system, **Orion**, with her own staff account.

Anything risky (sending to a client, booking, changing a deal) waits in Orion's approval queue until you say yes. As you trust her with more, you can let specific actions run on their own.

## What she does

- **Inbox:** triage, summaries, drafted replies, unsubscribe and sender rules
- **Calendar:** conflicts, scheduling, rescheduling, meeting prep and follow-ups
- **Briefings:** morning and evening briefs, deadlines and stalled work
- **Phone and SMS:** answers calls and texts on a work line, puts callers through to you, places calls you ask for (Twilio, ElevenLabs voice, local Whisper transcription)
- **Orion:** contacts, deals, tasks, appointments, proposals and approvals through Orion's MCP tools
- **Deep work:** longer research and writing jobs run by Claude Code or another engine, queued overnight if you like
- **Working with FRIDAY:** hands delivery work to FRIDAY, the project agent

## Requirements

- An **Orion** install (github.com/OrionBuilds/orion) with a staff account for Clara
- **agent-core** (github.com/OrionBuilds/orion-agent-core) cloned next to this folder
- Node.js 22, a Claude plan or Anthropic API key, and a Google Workspace or Microsoft 365 mailbox for Clara
- Optional: Twilio, ElevenLabs, whisper.cpp, LM Studio

## Get started

```
agents/
├── agent-core/
└── clara/
```

```bash
git clone https://github.com/OrionBuilds/orion-agent-core.git agent-core
git clone https://github.com/OrionBuilds/orion-clara.git clara
cd clara
bash scripts/security/check-repo.sh
npm install
cp .env.example .env.local        # fill in the Required sections
cp owner-profile.example.json owner-profile.json
cp knowledge/company.example.md knowledge/company.md
npm run dev                       # http://127.0.0.1:3939
```

Full setup, including Clara's Orion account, mailbox connection and running her as a service: **[docs/SETUP.md](docs/SETUP.md)**.

## Develop

```bash
npx tsc --noEmit
npm test
npm run build
```

Run `bash scripts/security/check-repo.sh` before you build or run anything you've cloned or pulled.

## Learn with the community

The free Autom8ion Lab classroom on Skool walks through setting up Orion, Clara, FRIDAY and Harvey. [Join the community](https://www.skool.com/autom8ion-lab-7149).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
