# Local LiveKit (dev)

Run the self-hosted media server in dev mode (placeholder keys, port 7880):

    livekit-server --dev

Credentials it uses (match `.env`): API key `devkey`, secret `secret`,
URL `ws://127.0.0.1:7880`. The `lk` CLI (brew `livekit-cli`) can mint tokens and
join rooms for smoke tests, e.g. `lk token create --api-key devkey --api-secret secret --join --room r --identity me`.
