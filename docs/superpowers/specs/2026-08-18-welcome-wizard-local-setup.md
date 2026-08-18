# Welcome Wizard — Local Setup, full sequence

**Status:** authoritative for the wizard's flow and copy. Supersedes the Flow
section and both 2026-08-17 revisions of
`2026-08-15-welcome-wizard-design.md`, which remains the reference for the
*reasoning* behind first-run detection, the credential audit, the react-aria
constraints, and the repo's own traps.

**Author:** Edwin, 2026-08-18, written screen by screen. **The copy below is the
design, not a paraphrase of it.** Where implementation and this document
disagree about wording, this document wins.

---

## The voice

The wizard is **Anderson talking**, first person, throughout. He introduces
himself before asking anything. He asks rather than instructs, and he explains
what he will do with an answer before he takes it.

This is the product's wedge made concrete: a crew you talk to, not a settings
panel with a chat box bolted on. First run is the only moment that claim is
made before anything can back it up.

---

## Gate · not numbered, no progress bar

> **Hello! My name is Anderson.**
> Anderson Smith, but Anderson is fine. Let's get acquainted — a minute or so,
> and you can change your mind about any of it later.
>
> **What shall I call you?**
> `[ your name ]`
>
> **Where would you like me to live?**
> ○ **On your machine** — I run right here, and I can use logins you already have
> ○ **In the cloud** — nothing to install, I'm ready right away
>
> `[ Just pick sensible things for me ]`  `[ Nice to meet you → ]`

**No progress bar here, and no number.** The gate settles which branch runs, so
a count before it would be a lie.

On continue it **collapses into a persistent, clickable chip**:
`Anderson · On your machine ✎`

---

## Step 1 of 6 · Where I think

> **Where should I get my thinking from, {name}?**
> Pick as many as you like — I'll use whichever suits each job.
>
> ☑ **Logins you already have** — nothing to paste
> &nbsp;&nbsp;✓ `claude` — you're signed in
> &nbsp;&nbsp;✓ `gemini` — you're signed in
> &nbsp;&nbsp;✗ `codex` — not installed
>
> ☐ **Your own API keys** — Anthropic · OpenAI · Google · OpenRouter
> ☐ **Models on your machine** — I'll download them, and nothing leaves your computer

Detected logins arrive **pre-checked**, so this step can be a single click. Keys
expand inline per provider with **live verification**. Local models expand to a
**runtime check for Ollama or LM Studio**.

Multi-select, not a fork: sources accumulate.

---

## Step 2 of 6 · What I think with

> **Which of these should I use, and for what?**
>
> My main brain `[ claude (login) ▾ ]`
> Quick little things `[ qwen3 8b (local) ▾ ]`
> If something's unavailable `[ nothing — I'll just tell you ▾ ]`
>
> *You've got 32GB of RAM, so I've leaned toward models that'll feel quick.
> I'll say something if you pick one I'd struggle to hold.*

**Every dropdown lists all configured sources together, mixed — not grouped by
origin.** Local picks show size, and download progress runs inline.

Three roles: **main brain**, **quick little things**, **fallback when something
is unavailable** (including an explicit "nothing — I'll just tell you").

---

## Step 3 of 6 · Talking out loud

> **Would you like to talk to me out loud?**
> ○ Yes, let's talk ○ Not right now
>
> *(on yes)*
> **How should I listen and speak?**
> ○ **Right here** — a small listening model and a voice, nothing leaves your computer
> ○ **Hosted** — I'll listen with `[ Deepgram ▾ ]` and speak with `[ ElevenLabs ▾ ]`
>
> **How should I sound?** `[ Warm ▾ ]` `[ ▶ Say something ]`

**On-device is preselected** — it matches the promise made at the gate.

---

## Step 4 of 6 · How I talk

> **Should I make small talk?**
> ○ Please do — I'll say hello properly and ask how things are going
> ○ Keep it brief — I'll answer and get out of your way
>
> **Should I keep up with what's happening in the world?**
> I'd need somewhere to look things up.
> ○ Yes → I'll search with `[ Brave ▾ ]` `[ your key ]`
> ○ No — I'll stick to what I already know

---

## Step 5 of 6 · Remembering, and what I may do

> **Should I remember our conversations?**
> ○ Yes, remember me ○ Start fresh each time
>
> *(if yes, and nothing configured can do embeddings)*
> **To remember properly I need a way to file things away — your login can't do
> that part.**
> ○ Let me download something small for it *(~90MB)* ○ I'll use a key ○ Never mind, I'll forget
>
> **What may I do without asking?**
> Read your files ○ Ask first ○ Go ahead ○ Never
> Run commands ○ Ask first ○ Go ahead ○ Never
> Browse the web ○ Ask first ○ Go ahead ○ Never
>
> *Where I keep all this:* `~/.smithagents/anderson` ✎

The embeddings fork matters: **a login cannot do embeddings**, so a login-only
user hits a real requirement here and is offered a small download rather than
being pushed into buying a key.

---

## Step 6 of 6 · Before we start

> **Here's what I've understood.**
> *(editable summary — every line jumps back to its step)*
>
> ✓ I checked my login — it works
> ✓ I asked myself a question and answered in 0.8s
> ✓ I tried my voice out
>
> **I think we're ready, {name}.** `[ Let's talk → ]`

The ticks are **receipts, not restatements** — each is something actually
exercised, including a real round trip with a measured latency.

---

## Rules holding it together

- **Every step after the gate carries a Skip that applies a stated default**,
  and each step is **re-runnable on its own afterward**. A wrong answer costs
  one step, never a restart.
- **Progress reads honestly as `Step n of 6`** because the branch was settled at
  the gate.
- **Editing the chip mid-flow** keeps name, small talk, current events, memory
  and permissions. It **clears** brain source, models and voice backend — **and
  says so specifically**. Before the provider step, it switches silently.
- **Three paths through this:**
  - **fully local** — never sees a credential field at all;
  - **login-only** — the fastest start, but forks at memory and voice, each with
    a small-download escape hatch so it still needs no key;
  - **mixed** — the realistic one, and it lives entirely in step 2.

---

## What this design drops

**The workspace step is gone.** Earlier revisions ended setup with a required
"Local workspace" step (what it is for, version control, GitHub if coding).
This sequence ends at *Before we start*, and the user creates a workspace from
the app when they have something to put in it. Repo-less contexts already ship,
so a workspace no longer needs a repo up front.
