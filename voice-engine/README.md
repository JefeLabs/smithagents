# voice-engine

The local **MLX audio LLM** (PRD §3). Runs a ~3B audio model in the Mac Studio's
unified memory to zero-shot clone voices and synthesize paralinguistic reactions
(sighs, "hmm") in milliseconds, writing assets straight into the repo-root
`audio-cache/`.

Its own project (Python) because it shares neither the JVM build nor the
front-end toolchain.

## Status

Skeleton only — the model runtime and the gateway-facing interface (how the
Spring Boot host triggers synthesis and reads back `audio-cache/`) are not yet
implemented. Candidate models: **Step Audio EditX**, **Qwen3-TTS**.

## TODO

- Choose + pin the MLX model and runtime in `pyproject.toml`.
- Define the trigger contract with the gateway (local HTTP? file watch? MCP?).
- Decide which reactions are **pre-cached** (committed) vs. generated on demand.
