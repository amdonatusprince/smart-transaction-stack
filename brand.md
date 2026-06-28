# Brand - Snapsis

Snapsis is a real-time Solana transaction operations console for proving that a bundle did more than get sent: it reached the right leader window, paid an evidence-backed tip, moved through commitment stages, and left a durable trace.

## Visual System

- Dark infrastructure console with compact density and high contrast.
- Acid green for landed/finalized signals, cyan for live network state, amber for pending/recovery, and red only for failed evidence.
- Monospace numerics for slots, signatures, latency, tips, and bundle ids.
- Thin borders, restrained glow, and no decorative data that is not backed by evidence.

## Voice

- Precise, operational, and evidence-first.
- Prefer "finalized in 1.2s" over "fast".
- Prefer "awaiting first bundle" over fake loading activity.
- Every claim should point back to Yellowstone, Jito, Solana RPC, the agent decision, or the SQLite evidence store.
