import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

type State = 'SUBMITTING' | 'SUBMITTED' | 'FINALIZED' | 'UNCERTAIN' | 'FAILED';
export interface SettlementRecord {
  state: State;
  signature: string;
  requestHash: string;
  submissionId?: string;
  result?: unknown;
}
export interface JournalStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<boolean>;
  withLock<T>(key: string, fn: () => Promise<T>, opts?: { ttlSec?: number; onBusy?: 'throw' | 'skip' }): Promise<T | null>;
}

export function settlementKey(transaction: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
  if (tx.version !== 'legacy') throw new Error('Only legacy transactions are accepted');
  return 'x402:' + createHash('sha256').update(tx.message.serialize()).digest('hex');
}

/**
 * Keeps the claim and public signature before making a relay submission.
 * Existing or ambiguous submissions are returned for reconciliation, never re-sent.
 */
export async function guardedSettlement<T>(
  store: JournalStore,
  unsignedTransaction: string,
  requestHash: string,
  operation: (journal: {
    submit(signedTransaction: string, send: () => Promise<{ id: string; signature: string }>): Promise<string>;
  }) => Promise<T>,
): Promise<{ state: State; signature?: string; result?: T }> {
  const key = settlementKey(unsignedTransaction);
  const result = await store.withLock(key, async () => {
    const existing = await store.get<SettlementRecord>(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error('Payment requirements do not match the recorded submission');
      return { state: existing.state, signature: existing.signature, result: existing.result as T | undefined };
    }

    let claimed = false;
    let signature: string | undefined;
    try {
      const settled = await operation({
        async submit(signedTransaction, send) {
          if (claimed) throw new Error('Submission already claimed');
          const tx = VersionedTransaction.deserialize(Buffer.from(signedTransaction, 'base64'));
          if (settlementKey(signedTransaction) !== key || tx.signatures.some(s => s.every(b => b === 0))) {
            throw new Error('Signed transaction does not match verified payment');
          }
          signature = bs58.encode(tx.signatures[0]);
          if (!await store.set(key, { state: 'SUBMITTING', signature, requestHash } satisfies SettlementRecord)) {
            throw new Error('Unable to persist submission');
          }
          claimed = true;
          const receipt = await send();
          if (!receipt.id || receipt.signature !== signature) throw new Error('Relayer receipt mismatch');
          if (!await store.set(key, { state: 'SUBMITTED', signature, requestHash, submissionId: receipt.id } satisfies SettlementRecord)) {
            throw new Error('Unable to persist relayer receipt');
          }
          return signature;
        },
      });
      if (!claimed || !signature) return { state: 'FAILED' as const, result: settled };
      const data = settled as { success?: boolean; transaction?: string };
      const state: State = data.success && data.transaction === signature ? 'FINALIZED' : 'UNCERTAIN';
      if (!await store.set(key, { state, signature, requestHash, result: settled } satisfies SettlementRecord)) {
        return { state: 'UNCERTAIN' as const, signature };
      }
      return { state, signature, requestHash, result: settled };
    } catch (error) {
      if (!claimed || !signature) throw error;
      // SUBMITTING is already durable even if this update fails.
      await store.set(key, { state: 'UNCERTAIN', signature, requestHash } satisfies SettlementRecord).catch(() => false);
      return { state: 'UNCERTAIN' as const, signature };
    }
  }, { ttlSec: 180, onBusy: 'skip' });
  return result ?? { state: 'UNCERTAIN' };
}
