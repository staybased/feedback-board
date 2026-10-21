// Tests for reference/token-gate.mjs against a local anvil chain.
// Needs Foundry (anvil + forge) on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { createTokenGate, memoryNonceStore, GateError } from '../reference/token-gate.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const DOMAIN = 'board.example';
const PORT = 18545 + Math.floor(Math.random() * 1000);
const chain = { ...foundry, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } };

const TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 id)',
  'function transferFrom(address from, address to, uint256 id)',
  'function mint1155(address to, uint256 id, uint256 amount)',
  'function setEnumerable(bool on)',
]);

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let anvil;
let client;
let wallet;
let token;

async function send(functionName, args) {
  const hash = await wallet.writeContract({ address: token, abi: TOKEN_ABI, functionName, args });
  await client.waitForTransactionReceipt({ hash });
}

function gateFor(gates, extra = {}) {
  return createTokenGate({ client, domain: DOMAIN, gates, nonces: memoryNonceStore(), ...extra });
}

async function signIn(gate, account, overrides = {}) {
  const nonce = overrides.nonce ?? (await gate.issueNonce());
  const message = createSiweMessage({
    address: account.address,
    chainId: chain.id,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: '1',
    ...overrides,
  });
  const signer = overrides.signer ?? account;
  const signature = await signer.signMessage({ message });
  return { message, signature };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GateError, `expected GateError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

before(async () => {
  execFileSync('forge', ['build', '--root', fixtures], { stdio: 'ignore' });
  const artifact = JSON.parse(readFileSync(join(fixtures, 'out/TestToken.sol/TestToken.json'), 'utf8'));

  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  client = createPublicClient({ chain, transport: http() });
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const [deployer] = await client.request({ method: 'eth_accounts' });
  wallet = createWalletClient({ chain, transport: http(), account: deployer });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  token = (await client.waitForTransactionReceipt({ hash })).contractAddress;

  await send('mint', [alice.address, 1n]);
  await send('mint', [alice.address, 2n]);
  await send('mint', [bob.address, 7n]);
  await send('mint1155', [carol.address, 9n, 3n]);
});

after(() => anvil?.kill());

// ── sign-in ─────────────────────────────────────────────────────────────────
test('a valid signature signs the wallet in, lowercased', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const { address } = await gate.verifySignIn(await signIn(gate, alice));
  assert.equal(address, alice.address.toLowerCase());
});

test('a nonce works once', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const signed = await signIn(gate, alice);
  await gate.verifySignIn(signed);
  await rejects(gate.verifySignIn(signed), 'invalid_nonce');
});

test('a nonce the server never issued is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await rejects(gate.verifySignIn(await signIn(gate, alice, { nonce: 'madeUpNonce12345' })), 'invalid_nonce');
});

test('an expired nonce is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }], { nonces: memoryNonceStore({ ttlMs: 1 }) });
  const signed = await signIn(gate, alice);
  await new Promise((r) => setTimeout(r, 10));
  await rejects(gate.verifySignIn(signed), 'invalid_nonce');
});

test('the nonce store refuses to grow without bound', async () => {
  const nonces = memoryNonceStore({ maxSize: 2 });
  await nonces.issue();
  await nonces.issue();
  await rejects(nonces.issue(), 'busy');
});

test('a message for another site is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await rejects(gate.verifySignIn(await signIn(gate, alice, { domain: 'evil.example' })), 'wrong_domain');
});

test('a message for another chain is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await rejects(gate.verifySignIn(await signIn(gate, alice, { chainId: 1 })), 'wrong_chain');
});

test('an expired message is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const expirationTime = new Date(Date.now() - 1000);
  await rejects(gate.verifySignIn(await signIn(gate, alice, { expirationTime })), 'expired');
});

test('a signature from a different wallet is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await rejects(gate.verifySignIn(await signIn(gate, alice, { signer: stranger })), 'invalid_signature');
});

test('garbage input is rejected', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await rejects(gate.verifySignIn({ message: 'hello', signature: '0x00' }), 'invalid_message');
  await rejects(gate.verifySignIn(), 'invalid_message');
});

// ── holder checks ───────────────────────────────────────────────────────────
test('erc721: holders pass, others do not', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  assert.equal(await gate.isHolder(alice.address), true);
  assert.equal(await gate.isHolder(stranger.address), false);
});

test('erc1155: checks the configured token id', async () => {
  assert.equal(await gateFor([{ address: token, standard: 'erc1155', tokenId: 9n }]).isHolder(carol.address), true);
  assert.equal(await gateFor([{ address: token, standard: 'erc1155', tokenId: 8n }]).isHolder(carol.address), false);
  assert.equal(
    await gateFor([{ address: token, standard: 'erc1155', tokenId: 9n, minBalance: 4n }]).isHolder(carol.address),
    false,
  );
});

test('erc20-style minimum balance', async () => {
  const gate = gateFor([{ address: token, standard: 'erc20', minBalance: 2n }]);
  assert.equal(await gate.isHolder(alice.address), true);   // holds 2
  assert.equal(await gate.isHolder(bob.address), false);    // holds 1
});

test('several gates: meeting any one is enough', async () => {
  const gate = gateFor([
    { address: token, standard: 'erc1155', tokenId: 9n },
    { address: token, standard: 'erc721', minBalance: 2n },
  ]);
  assert.equal(await gate.isHolder(alice.address), true);
  assert.equal(await gate.isHolder(carol.address), true);
  assert.equal(await gate.isHolder(bob.address), false);
});

test('an unreachable RPC fails closed', async () => {
  const dead = createPublicClient({ chain, transport: http('http://127.0.0.1:1', { retryCount: 0 }) });
  const gate = gateFor([{ address: token, standard: 'erc721' }], { client: dead });
  await rejects(gate.isHolder(alice.address), 'gate_unavailable');
});

// ── ballots ─────────────────────────────────────────────────────────────────
test('ballots list the tokens a wallet holds', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const prefix = `${chain.id}:${token.toLowerCase()}:`;
  assert.deepEqual((await gate.ballotsFor(alice.address)).sort(), [`${prefix}1`, `${prefix}2`]);
  assert.deepEqual(await gate.ballotsFor(stranger.address), []);
});

test('client-suggested token ids are checked with ownerOf', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const prefix = `${chain.id}:${token.toLowerCase()}:`;
  // 7 belongs to bob, 999 does not exist, 'abc' is not a number: all dropped.
  assert.deepEqual(await gate.ballotsFor(alice.address, { tokenIds: ['1', 7n, 999, 'abc', '1'] }), [`${prefix}1`]);
});

test('ballots follow the token when it moves', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  const prefix = `${chain.id}:${token.toLowerCase()}:`;
  await send('transferFrom', [alice.address, bob.address, 1n]);
  assert.deepEqual(await gate.ballotsFor(alice.address), [`${prefix}2`]);
  assert.deepEqual((await gate.ballotsFor(bob.address)).sort(), [`${prefix}1`, `${prefix}7`]);
});

test('without enumeration, ballots need token ids', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }]);
  await send('setEnumerable', [false]);
  try {
    await rejects(gate.ballotsFor(bob.address), 'enumeration_unsupported');
    assert.equal((await gate.ballotsFor(bob.address, { tokenIds: [7] })).length, 1);
  } finally {
    await send('setEnumerable', [true]);
  }
});

test('ballots refuse erc1155 and erc20 gates', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }, { address: token, standard: 'erc1155', tokenId: 9n }]);
  await assert.rejects(gate.ballotsFor(alice.address), /every gate to be erc721/);
});

test('an RPC outage during ballots is an outage, not "not a holder"', async () => {
  const dead = createPublicClient({ chain, transport: http('http://127.0.0.1:1', { retryCount: 0 }) });
  const gate = gateFor([{ address: token, standard: 'erc721' }], { client: dead });
  await rejects(gate.ballotsFor(alice.address), 'gate_unavailable');
  await rejects(gate.ballotsFor(alice.address, { tokenIds: [2] }), 'gate_unavailable');
});

test('ballots are capped', async () => {
  const gate = gateFor([{ address: token, standard: 'erc721' }], { maxBallots: 1 });
  assert.equal((await gate.ballotsFor(bob.address)).length, 1);
});

// ── configuration ───────────────────────────────────────────────────────────
test('bad configuration fails at startup, not at vote time', () => {
  const base = { client, domain: DOMAIN, nonces: memoryNonceStore() };
  assert.throws(() => createTokenGate({ ...base, gates: [] }), /at least one gate/);
  assert.throws(() => createTokenGate({ ...base, gates: [{ address: '0x123', standard: 'erc721' }] }), /invalid contract/);
  assert.throws(() => createTokenGate({ ...base, gates: [{ address: token, standard: 'erc404' }] }), /standard must be/);
  assert.throws(() => createTokenGate({ ...base, gates: [{ address: token, standard: 'erc1155' }] }), /needs a tokenId/);
  assert.throws(() => createTokenGate({ ...base, gates: [{ address: token, standard: 'erc20' }] }), /needs minBalance/);
  assert.throws(() => createTokenGate({ ...base, domain: '', gates: [{ address: token, standard: 'erc721' }] }), /domain/);
});
