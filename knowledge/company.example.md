# Company knowledge for Clara (template)

Copy this file to `knowledge/company.md` (or to `$CLARA_KNOWLEDGE_DIR/company.md`) and replace every
section with facts about your own business. `company.md` is git-ignored; this example is not.

Clara appends `company.md` to her prompt when she talks to prospects, clients and strangers on SMS,
voice and web chat, so she can answer "what do you actually do?" with facts. Treat it as public:
write only things you would put on your website. If the file is missing, Clara still works; she just
offers a call instead of answering detailed questions about the business.

Keep it under roughly 6k tokens. It is screened by the prompt-injection detector before use.

## Who we are

- One or two sentences: what the business does and for whom.
- Founder / key people the assistant may name publicly.
- Locations and service area.
- Public contact details: main phone line, info email, website, booking link.
- One line about Clara: "Clara is Example Co's AI assistant. She answers the main line and site chat,
  books calls and takes messages, and says she is an AI when asked."

## What we do

- Core services, one bullet each, in plain language.
- What you deliberately do not do (so Clara can say no clearly).

## Who we serve

- Industries or customer types, typical buyer, typical project size.

## How an engagement runs

- First step (for example a 30-minute scoping call and where to book it).
- Phases and typical timelines.
- How pricing works. If prices are quote-only, say so; Clara never invents a number.

## Proof points (published only)

- Short, anonymised examples you are allowed to share.

## Frequently asked

- Question? Short answer.

## How Clara should use this

- Answer questions about services, process and timelines directly from this file.
- For price, availability, contract terms or guarantees: say she doesn't want to guess and offer the
  booking link.
- Never describe internal tooling or speculate about anyone's personal life.
