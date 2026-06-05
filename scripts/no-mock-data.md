# No Mock Data Policy

This project does not generate fake lifecycle evidence. Any file exported from `txstack export` is derived from the SQLite lifecycle database, and that database is written only by live runner commands.

Test policy:

- `LIVE_DEVNET=1 pnpm run test:live:devnet` reads real devnet RPC values.
- `LIVE_MAINNET=1 pnpm run test:live:mainnet` reads real mainnet Jito values without submitting bundles.
- Real Jito bundle submissions require `--live` and a funded payer.
