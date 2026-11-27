# x402 Solana Devnet qualification

This experimental plugin exposes only `/verify`. It uses the x402 SVM reference
verifier with Squads CPI simulation, a Devnet USDC mint, a bounded fee payer,
compute limits and legacy transaction parsing. The fee payer is read from an
active Solana Devnet relayer. It does not expose a facilitator supported kind
or settle payments. Do not route production traffic to this qualification plugin.

The sponsor adapter signs and sends only through the OpenZeppelin relayer and
checks that sponsorship preserves the message and external signatures.
The experimental settlement branch now uses a Redis-backed plugin journal with a
distributed lock. It records the public transaction signature before submission
and refuses automatic re-submission after an ambiguous acknowledgement. The
reference x402 verifier performs post-confirmation CPI verification. An explicit
plugin flag is required, and it remains disabled in the local configuration.
Uncertain records are reconciled using the existing signature and the reference
facilitator's on-chain confirmation and inner-instruction verification, without
re-signing or re-sending. An end-to-end Squads payment and Redis durability
configuration are still required before advertising settlement.

Build an isolated test bundle using esbuild with the dependency lockfile:

```sh
cd plugins
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec esbuild x402-solana/index.ts --bundle --platform=node --format=cjs --target=node20 --outfile=x402-solana-test.ts
```

The local fork test registered the bundle under plugin ID `x402-solana-test`.
A malformed request was rejected and a syntactically valid transaction invoking
an unauthorized program was rejected by the reference verifier. No settlement
was performed. The running test bundle was copied into the container and must be
rebuilt into a persistent image before use beyond local qualification.
