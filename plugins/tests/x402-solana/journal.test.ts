import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { guardedSettlement, settlementKey, type JournalStore } from '../../x402-solana/journal';

function fixture() {
  const payer = Keypair.generate(), owner = Keypair.generate();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToLegacyMessage();
  const unsigned = new VersionedTransaction(message);
  unsigned.sign([owner]);
  const first = Buffer.from(unsigned.serialize()).toString('base64');
  unsigned.sign([payer]);
  return { first, signed: Buffer.from(unsigned.serialize()).toString('base64'), signature: bs58.encode(unsigned.signatures[0]) };
}
function storage(): JournalStore {
  const values = new Map<string, unknown>();
  let locked = false;
  return {
    get: async <T>(key: string) => (values.get(key) as T) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
    withLock: async (_key, fn) => {
      if (locked) return null;
      locked = true;
      try { return await fn(); } finally { locked = false; }
    },
  };
}
test('lost acknowledgement retains the signature and prevents a second submission', async () => {
  const tx = fixture(), store = storage(), send = jest.fn(async (): Promise<{ id: string; signature: string }> => { throw new Error('timeout'); });
  const operation = async (journal: { submit: (signed: string, send: () => Promise<{ id: string; signature: string }>) => Promise<string> }) => {
    await journal.submit(tx.signed, send); return { success: true, transaction: tx.signature };
  };
  expect(await guardedSettlement(store, tx.first, 'same-request', operation)).toMatchObject({ state: 'UNCERTAIN', signature: tx.signature });
  expect(await guardedSettlement(store, tx.first, 'same-request', operation)).toMatchObject({ state: 'UNCERTAIN', signature: tx.signature });
  expect(send).toHaveBeenCalledTimes(1);
});
test('concurrent calls submit once and return the persisted final result', async () => {
  const tx = fixture(), store = storage();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const send = jest.fn(async () => { await waiting; return { id: 'relay-1', signature: tx.signature }; });
  const operation = async (journal: { submit: (signed: string, send: () => Promise<{ id: string; signature: string }>) => Promise<string> }) => {
    await journal.submit(tx.signed, send); return { success: true, transaction: tx.signature };
  };
  const first = guardedSettlement(store, tx.first, 'same-request', operation);
  await new Promise(resolve => setImmediate(resolve));
  expect((await guardedSettlement(store, tx.first, 'same-request', operation)).state).toBe('UNCERTAIN');
  release();
  expect((await first).state).toBe('FINALIZED');
  expect((await guardedSettlement(store, tx.first, 'same-request', operation)).state).toBe('FINALIZED');
  expect(send).toHaveBeenCalledTimes(1);
});
test('journal failure prevents submission and signature changes retain the message key', async () => {
  const tx = fixture(), store = storage(), send = jest.fn();
  expect(settlementKey(tx.first)).toBe(settlementKey(tx.signed));
  store.set = async () => false;
  await expect(guardedSettlement(store, tx.first, 'same-request', j => j.submit(tx.signed, send))).rejects.toThrow('persist');
  expect(send).not.toHaveBeenCalled();
});

test('does not reuse a settlement for different payment requirements', async () => {
  const tx = fixture(), store = storage();
  await guardedSettlement(store, tx.first, 'request-a', async journal => {
    await journal.submit(tx.signed, async () => ({ id: 'relay', signature: tx.signature }));
    return { success: true, transaction: tx.signature };
  });
  await expect(guardedSettlement(store, tx.first, 'request-b', async () => ({}))).rejects.toThrow('requirements');
});

test('reconciles an uncertain signature without resending', async () => {
  const tx = fixture(), store = storage(), send = jest.fn(async (): Promise<{ id: string; signature: string }> => { throw new Error('lost ACK'); });
  const op = async (journal: { submit: (signed: string, send: () => Promise<{ id: string; signature: string }>) => Promise<string> }) => {
    await journal.submit(tx.signed, send); return {};
  };
  await guardedSettlement(store, tx.first, 'req', op);
  const recovered = await guardedSettlement(store, tx.first, 'req', op, async record => {
    expect(record.signature).toBe(tx.signature);
    return { success: true, transaction: tx.signature };
  });
  expect(recovered.state).toBe('FINALIZED');
  expect(send).toHaveBeenCalledTimes(1);
});
