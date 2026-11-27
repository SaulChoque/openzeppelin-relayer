import { createHash } from 'node:crypto';
import { address, type MessagePartialSigner, type TransactionSigner } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { VersionedTransaction } from '@solana/web3.js';
import { createSolanaSponsor, type SolanaRelayer } from './sponsor';
import { guardedSettlement } from './journal';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/**
 * Devnet verification endpoint for the fork's experimental Solana facilitator.
 * Settlement remains unavailable until relayer submission reconciliation is durable.
 */
export async function handler({ api, kv, params, route, config }: PluginContext) {
  const settling = route === '/settle';
  if (route !== '/verify' && !settling) return { isValid: false, invalidReason: 'unsupported_route' };
  if (settling && config?.enableExperimentalSettlement !== true) {
    return { success: false, errorReason: 'settlement_not_available', network: DEVNET, transaction: '', payer: '' };
  }
  const payload = params?.paymentPayload;
  const requirements = params?.paymentRequirements;
  if (params?.x402Version !== 2 || payload?.x402Version !== 2 ||
      requirements?.network !== DEVNET || requirements?.asset !== USDC ||
      requirements?.scheme !== 'exact' || typeof payload?.payload?.transaction !== 'string' ||
      payload.payload.transaction.length > 1644) {
    return { isValid: false, invalidReason: 'invalid_exact_payload_malformed' };
  }
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, 'base64'));
    if (tx.version !== 'legacy') return { isValid: false, invalidReason: 'unsupported_transaction_version' };
  } catch {
    return { isValid: false, invalidReason: 'invalid_exact_payload_malformed' };
  }
  const id = config?.relayerId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Solana relayerId required');
  const relayer = api.useRelayer(id);
  const response = await relayer.getRelayer();
  const metadata = (response as any).data ?? response;
  if (metadata.network_type !== 'solana' || metadata.network !== 'devnet' || metadata.paused !== false || metadata.system_disabled === true) {
    throw new Error('Active Solana Devnet relayer required');
  }
  const feePayer = address(metadata.address);
  if (requirements.extra?.feePayer !== feePayer) return { isValid: false, invalidReason: 'invalid_exact_svm_fee_payer' };

  // The SDK's RPC helpers need the public address only. All signing is disabled here.
  const publicSigner = {
    address: feePayer,
    signMessages: async () => { throw new Error('Verification cannot sign'); },
    signTransactions: async () => { throw new Error('Verification cannot sign'); },
  } as unknown as TransactionSigner & MessagePartialSigner;
  const rpc = toFacilitatorSvmSigner(publicSigner, { defaultRpcUrl: 'https://api.devnet.solana.com' });
  const scheme = new ExactSvmScheme(rpc, undefined, {
    enableSmartWalletVerification: true,
    transactionVersions: [0],
    maxComputeUnits: 400_000,
    maxPriorityFeeMicroLamports: 50_000,
    maxRequiredSignatures: 2,
  });
  if (!settling) return scheme.verify(payload, requirements);

  const sponsor = createSolanaSponsor(relayer as unknown as SolanaRelayer, feePayer);
  const requestHash = createHash('sha256').update(JSON.stringify([payload.accepted, requirements])).digest('hex');
  const guarded = await guardedSettlement(kv, payload.payload.transaction, requestHash, async journal => {
    const settlementSigner = {
      ...rpc,
      signTransaction: async (transaction: string, payer: string, network: string) => {
        if (payer !== feePayer || network !== DEVNET) throw new Error('Unexpected fee payer or network');
        return sponsor.signTransaction(transaction);
      },
      sendTransaction: async (transaction: string, network: string) => {
        if (network !== DEVNET) throw new Error('Unexpected network');
        return journal.submit(transaction, () => sponsor.submit(transaction));
      },
    };
    const settlement = new ExactSvmScheme(settlementSigner, undefined, {
      enableSmartWalletVerification: true,
      transactionVersions: [0],
      maxComputeUnits: 400_000,
      maxPriorityFeeMicroLamports: 50_000,
      maxRequiredSignatures: 2,
    });
    return settlement.settle(payload, requirements);
  });
  if (guarded.state === 'FINALIZED' && guarded.result) return guarded.result;
  return {
    success: false,
    errorReason: guarded.state === 'FAILED' ? 'verification_failed' : 'settlement_pending',
    network: DEVNET,
    transaction: guarded.signature ?? '',
    payer: '',
  };
}
