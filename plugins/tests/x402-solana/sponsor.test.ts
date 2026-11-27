import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSolanaSponsor } from '../../x402-solana/sponsor';

describe('Solana fork sponsor', () => {
  const payer = Keypair.generate();
  const owner = Keypair.generate();
  function transaction() {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToLegacyMessage();
    const tx = new VersionedTransaction(message);
    tx.sign([owner]);
    return Buffer.from(tx.serialize()).toString('base64');
  }
  test('preserves external signature and submits only through relayer', async () => {
    const relayer = {
      signTransaction: jest.fn(async ({ transaction: encoded }: { transaction: string }) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
        tx.sign([payer]);
        return { transaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[0]) };
      }),
      sendTransaction: jest.fn(async () => ({ id: 'submission-1' })),
    };
    const sponsor = createSolanaSponsor(relayer, payer.publicKey.toBase58());
    const signed = await sponsor.signTransaction(transaction());
    const sent = await sponsor.submit(signed);
    expect(sent.id).toBe('submission-1');
    expect(relayer.signTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.sendTransaction).toHaveBeenCalledTimes(1);
  });
  test('rejects a modified relayer message before submission', async () => {
    const relayer = {
      signTransaction: jest.fn(async ({ transaction: encoded }: { transaction: string }) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
        tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.sign([payer]);
        return { transaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[0]) };
      }),
      sendTransaction: jest.fn(async () => ({ id: 'unexpected' })),
    };
    await expect(createSolanaSponsor(relayer, payer.publicKey.toBase58()).signTransaction(transaction())).rejects.toThrow('changed');
    expect(relayer.sendTransaction).not.toHaveBeenCalled();
  });
});
