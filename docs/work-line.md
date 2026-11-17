# The owner's work line

Optional. Clara can answer the owner's existing work phone without porting the number:

- **Calls:** the carrier's unconditional call forwarding (often `*72` + number to enable, `*73` to
  disable) sends every call to a Twilio number used only for this (`CLARA_WORKLINE_NUMBER`). Calls
  from the owner's own numbers are recognised and get the owner path.
- **Texts (optional):** a [BlueBubbles](https://bluebubbles.app) server on a Mac signed into the
  owner's Apple ID relays iMessage/SMS both ways, so replies go out from the real work number.
- **Urgent calls** are held while Clara texts the owner's personal cell ("reply 1 to take it, 2 to
  pass"). 1 rings that cell and bridges the caller; 2, or no reply before the timeout, brings the
  caller back to Clara to leave a message.

Nothing here is active until the variables below are set.

## Environment

| Variable | What it is |
|---|---|
| `OWNER_PHONE` | Identifies the owner (E.164). |
| `OWNER_WORK_PHONE` | The work phone's number. Identifies the owner and is recognised as a forwarding source (`ForwardedFrom`). |
| `OWNER_PERSONAL_PHONE` | The owner's personal cell. Owner-bound calls and texts go here, and it is the only number a transfer ever rings. Unset → no transfers; Clara takes a message and important matters go by email. |
| `CLARA_PUT_THROUGH` | Optional seed for the always-put-through list: `Name:+15550100100,Other:+1555…`. The owner can also change the list in plain words on any channel. |
| `CLARA_WORKLINE_NUMBER` | The Twilio number the work phone forwards to. Calls to it get the work-line persona. |
| `BLUEBUBBLES_URL` | BlueBubbles server on the LAN, e.g. `http://192.168.1.50:1234`. |
| `BLUEBUBBLES_PASSWORD` | BlueBubbles server password (outbound sends and the health ping). |
| `BLUEBUBBLES_WEBHOOK_SECRET` | Long random string; BlueBubbles puts it in the webhook URL because it can't sign requests. |
| `OWNER_WORK_PHONE_VERIFIED` | `1` once the work number is a verified outgoing caller ID in Twilio, so "connect me to X" shows it. |
| `CLARA_IMESSAGE_REPLY_DELAY_SEC` | Optional, default `60`. Wait before answering a text, so the owner can reply first. |
| `CLARA_HOLD_TIMEOUT_SEC` | Optional, default `45`. How long a caller holds before Clara takes a message. |
| `CLARA_HOLD_AUDIO_FILE` | Optional hold audio. Default `<dataDir>/audio/hold.mp3` (also `.wav`/`.m4a`). Otherwise Twilio's sample music plays. |
| `CLARA_HOLD_AUDIO_URL` | Optional URL Twilio plays directly instead of the file. |
| `CLARA_PUBLIC_WEBHOOK_BASE` | Public HTTPS base, e.g. `https://clara.example.com`. The hold flow needs it for the TwiML it points live calls at. |

## Wiring

1. **Twilio, on the work-line number:** "A call comes in" → `POST https://clara.example.com/api/channels/twilio/voice`;
   status callback → `https://clara.example.com/api/channels/twilio/voice/status` (event: completed).
2. **BlueBubbles › API & Webhooks:** a **New Messages** webhook →
   `https://clara.example.com/api/channels/imessage?secret=<BLUEBUBBLES_WEBHOOK_SECRET>`.
3. **On the work phone:** enable call forwarding to the work-line number.

## What Clara does

| Situation | Clara |
|---|---|
| On the always-put-through list | Greets the caller by name, puts them on hold and texts the owner. No triage. If the owner doesn't take it, she takes a message. |
| Any work call | Answers as the owner's AI assistant (`CLARA_WORKLINE_IDENTITY`), never as the owner. Takes name, company, need, timing and callback number, answers common questions, and can offer open slots on the owner's calendar. |
| Urgent | One hold attempt per call, e.g. `Work call holding: Taylor (Acme Co) — needs: delivery moved to Friday. Reply 1 to take it, 2 to pass. — Clara`. Voicemail can't accept a transfer (machine detection hangs that leg up). One caller holds at a time. |
| Text from a contact | Waits, stays quiet if the owner replies personally (and in that thread for 12 hours), otherwise replies as Clara and signs her name. |
| Money, prices, contracts, scope | Never agreed to; passed to the owner. |
| Group chats, short codes, verification codes, tapbacks, personal contacts | Never answered. |
| STOP / opted-out numbers | Honoured via the same DNC registry as Clara's own line. |
| Important matters | One text per contact per matter, at most every 12 hours, none during quiet hours except emergencies. |
| Everything else | Summarised in the morning brief, with a callback list. |
| Relay down 15 min | One email (never a text), and another when it recovers. |

**Loop guard:** Clara never rings or texts the work phone, `CLARA_WORKLINE_NUMBER` or her own
Twilio number to reach the owner; with forwarding on, those lead straight back to her.
