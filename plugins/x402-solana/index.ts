import { address, type MessagePartialSigner, type TransactionSigner } from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { VersionedTransaction } from '@solana/web3.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/**
 * Devnet verification endpoint for the fork's experimental Solana facilitator.
 * Settlement remains unavailable until relayer submission reconciliation is durable.
 */
export async function handler({ api, params, route, config }: PluginContext) {
  if (route !== '/verify') return { isValid: false, invalidReason: 'settlement_not_available' };
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
  return scheme.verify(payload, requirements);
}
