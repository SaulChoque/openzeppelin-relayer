# x402 Solana Devnet qualification

This Devnet pilot plugin exposes `/supported`, `/verify` and `/settle` when settlement is enabled. It uses the x402 SVM reference
verifier with Squads CPI simulation, a Devnet USDC mint, a bounded fee payer,
compute limits and legacy transaction parsing. The fee payer is read from an
active Solana Devnet relayer. The facilitator is restricted to Devnet.

The sponsor adapter signs and sends only through the OpenZeppelin relayer and
checks that sponsorship preserves the message and external signatures.
The experimental settlement branch now uses a Redis-backed plugin journal with a
distributed lock. It records the public transaction signature before submission
and refuses automatic re-submission after an ambiguous acknowledgement. The
reference x402 verifier performs post-confirmation CPI verification. An explicit
plugin flag is required, and it remains disabled in the local configuration.
Uncertain records are reconciled using the existing signature and the reference
facilitator's on-chain confirmation and inner-instruction verification, without
re-signing or re-sending. An end-to-end Squads payment was finalized through the TilcAI Devnet API.
The pilot uses Redis AOF with appendfsync always.

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

## Devnet evidence

The public TilcAI development API verified and settled 0.01 USDC from a Squads
vault on 2026-11-27. The finalized signature is
`2hW6DBj18eVRFZVAWQtVkatXB7Uuf1EN18vJKFELEzN68aX9MEacRrMozZth6CuUsEpFf1iLn2ESNubNPxa8985K`.
Repeated settlement returned the same signature, including after restarting the
pilot relayer and its Redis. This evidence is Devnet-specific.
