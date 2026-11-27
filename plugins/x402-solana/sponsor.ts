import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface SolanaRelayer {
  signTransaction(body: { transaction: string }): Promise<{ transaction: string; signature: string }>;
  sendTransaction(body: { transaction: string }): Promise<{ id: string; signature?: string | null }>;
}

/** Only the Devnet fork signs and sends. External signatures and the message must survive intact. */
export function createSolanaSponsor(relayer: SolanaRelayer, feePayer: string) {
  function decode(transaction: string) {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    if (tx.version !== 'legacy') throw new Error('Relayer accepts legacy transactions only');
    if (tx.message.staticAccountKeys[0]?.toBase58() !== feePayer) throw new Error('Relayer fee payer mismatch');
    return tx;
  }

  return {
    async signTransaction(transaction: string): Promise<string> {
      const original = decode(transaction);
      if (!original.signatures[0].every(byte => byte === 0)) throw new Error('Fee payer slot must be empty');
      if (original.signatures.slice(1).some(sig => sig.every(byte => byte === 0))) throw new Error('Missing external signature');
      const signed = await relayer.signTransaction({ transaction });
      const result = decode(signed.transaction);
      if (!Buffer.from(original.message.serialize()).equals(Buffer.from(result.message.serialize())) ||
          original.signatures.slice(1).some((sig, index) => !Buffer.from(sig).equals(Buffer.from(result.signatures[index + 1]))) ||
          result.signatures[0].every(byte => byte === 0) ||
          bs58.encode(result.signatures[0]) !== signed.signature) {
        throw new Error('Relayer changed the message or signatures');
      }
      return signed.transaction;
    },

    async submit(transaction: string): Promise<{ id: string; signature: string }> {
      const signed = decode(transaction);
      if (signed.signatures.some(sig => sig.every(byte => byte === 0))) throw new Error('Missing signature');
      const signature = bs58.encode(signed.signatures[0]);
      const receipt = await relayer.sendTransaction({ transaction });
      if (!receipt.id || (receipt.signature && receipt.signature !== signature)) throw new Error('Invalid relayer receipt');
      return { id: receipt.id, signature };
    },
  };
}
