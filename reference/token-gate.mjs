// Token gate for the feedback board: wallet sign-in (EIP-4361 / SIWE) and
// on-chain holder checks. Server-side only. Needs viem 2.x.
//
//   const gate = createTokenGate({
//     rpcUrl: process.env.RPC_URL,
//     chain: mainnet,                       // from 'viem/chains'
//     domain: 'example.com',                // the host your sign-in page runs on
//     gates: [{ address: '0x…', standard: 'erc721' }],
//     nonces: memoryNonceStore(),           // use a shared store with >1 server
//   });
//
//   GET  /auth/nonce        → { nonce: await gate.issueNonce() }   (rate-limit this route)
//   POST /auth/verify       → const { address } = await gate.verifySignIn(body)
//                             then start a server session for `address`: a random
//                             session id in an httpOnly, Secure, SameSite cookie,
//                             or a signed session cookie. Never a cookie holding
//                             the bare address: anyone could forge it.
//   POST /feedback/:id/vote → const ballots = await gate.ballotsFor(session.address)
//                             feedback_vote_gated(session.address, id, value, ballots)
//
// Fails closed: an RPC error never counts as holding a token.
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, isAddress, parseAbi } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';

export class GateError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'GateError';
    this.code = code;
  }
}

const ERC721_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);
const ERC1155_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);
const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

const STANDARDS = new Set(['erc721', 'erc1155', 'erc20']);

// Single-use nonces with a short life. In-memory: fine for one process.
// With several servers, back issue/consume with your database or Redis.
// maxSize bounds memory if someone floods the nonce route; rate-limit it too.
export function memoryNonceStore({ ttlMs = 5 * 60_000, maxSize = 10_000 } = {}) {
  const expiries = new Map();
  const sweep = (now) => {
    for (const [nonce, expiresAt] of expiries) if (expiresAt <= now) expiries.delete(nonce);
  };
  return {
    async issue() {
      const now = Date.now();
      sweep(now);
      if (expiries.size >= maxSize) throw new GateError('busy');
      const nonce = generateSiweNonce();
      expiries.set(nonce, now + ttlMs);
      return nonce;
    },
    async consume(nonce) {
      const expiresAt = expiries.get(nonce);
      expiries.delete(nonce);
      return expiresAt !== undefined && expiresAt > Date.now();
    },
  };
}

function normalizeGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('token gate: at least one gate is required');
  return gates.map((g, i) => {
    if (!g || !isAddress(g.address ?? '', { strict: false })) throw new Error(`token gate ${i}: invalid contract address`);
    if (!STANDARDS.has(g.standard)) throw new Error(`token gate ${i}: standard must be erc721, erc1155, or erc20`);
    if (g.standard === 'erc1155' && g.tokenId === undefined) throw new Error(`token gate ${i}: erc1155 needs a tokenId`);
    if (g.standard === 'erc20' && g.minBalance === undefined) {
      throw new Error(`token gate ${i}: erc20 needs minBalance in base units (e.g. 100n * 10n ** 18n)`);
    }
    return {
      address: g.address.toLowerCase(),
      standard: g.standard,
      tokenId: g.tokenId === undefined ? undefined : BigInt(g.tokenId),
      minBalance: BigInt(g.minBalance ?? 1),
    };
  });
}

export function createTokenGate({ rpcUrl, chain, client, domain, gates, nonces, maxBallots = 50 }) {
  if (!domain) throw new Error('token gate: domain is required');
  if (!nonces) throw new Error('token gate: a nonce store is required');
  const publicClient = client ?? createPublicClient({ chain, transport: http(rpcUrl, { batch: true }) });
  const chainId = publicClient.chain?.id;
  if (!chainId) throw new Error('token gate: chain is required');
  const configured = normalizeGates(gates);

  const read = async (args) => {
    try {
      return await publicClient.readContract(args);
    } catch (err) {
      throw new GateError('gate_unavailable', err);
    }
  };

  // A contract revert is an answer ("no such token"); anything else (timeout,
  // RPC down) is an outage and must not be read as "not a holder".
  const reverted = (err) => err instanceof BaseError && Boolean(err.walk((e) => e instanceof ContractFunctionRevertedError));

  const meets = async (gate, owner) => {
    if (gate.standard === 'erc1155') {
      const balance = await read({
        address: gate.address, abi: ERC1155_ABI, functionName: 'balanceOf', args: [owner, gate.tokenId],
      });
      return balance >= gate.minBalance;
    }
    const abi = gate.standard === 'erc721' ? ERC721_ABI : ERC20_ABI;
    const balance = await read({ address: gate.address, abi, functionName: 'balanceOf', args: [owner] });
    return balance >= gate.minBalance;
  };

  const ballot = (gate, tokenId) => `${chainId}:${gate.address}:${tokenId}`;

  const ownedBy = async (gate, owner, tokenId) => {
    let id;
    try {
      id = BigInt(tokenId);
    } catch {
      return false; // not a number: cannot be a token
    }
    try {
      const holder = await publicClient.readContract({
        address: gate.address, abi: ERC721_ABI, functionName: 'ownerOf', args: [id],
      });
      return holder.toLowerCase() === owner;
    } catch (err) {
      if (reverted(err)) return false; // ownerOf reverts for tokens that do not exist
      throw new GateError('gate_unavailable', err);
    }
  };

  const enumerate = async (gate, owner) => {
    const balance = await read({ address: gate.address, abi: ERC721_ABI, functionName: 'balanceOf', args: [owner] });
    const count = Number(balance < BigInt(maxBallots) ? balance : BigInt(maxBallots));
    try {
      return await Promise.all(
        Array.from({ length: count }, (_, index) => publicClient.readContract({
          address: gate.address, abi: ERC721_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(index)],
        })),
      );
    } catch (err) {
      throw new GateError(reverted(err) ? 'enumeration_unsupported' : 'gate_unavailable', err);
    }
  };

  return {
    issueNonce: () => nonces.issue(),

    // Returns { address } (lowercased) or throws GateError with a code:
    // invalid_message, wrong_domain, wrong_chain, expired, invalid_nonce, invalid_signature.
    async verifySignIn({ message, signature } = {}) {
      let parsed;
      try {
        parsed = parseSiweMessage(String(message ?? ''));
      } catch {
        throw new GateError('invalid_message');
      }
      if (!parsed.address || !parsed.nonce || !parsed.domain) throw new GateError('invalid_message');
      if (parsed.domain !== domain) throw new GateError('wrong_domain');
      if (parsed.chainId !== chainId) throw new GateError('wrong_chain');
      if (parsed.expirationTime && parsed.expirationTime <= new Date()) throw new GateError('expired');
      // Burn the nonce before checking the signature: one attempt per nonce.
      if (!(await nonces.consume(parsed.nonce))) throw new GateError('invalid_nonce');

      let valid = false;
      try {
        // Pass domain and nonce: viem only validates the fields you give it.
        valid = await publicClient.verifySiweMessage({ message, signature, domain, nonce: parsed.nonce });
      } catch {
        valid = false;
      }
      if (!valid) throw new GateError('invalid_signature');
      return { address: parsed.address.toLowerCase() };
    },

    // True when the wallet meets ANY configured gate.
    async isHolder(address) {
      const owner = address.toLowerCase();
      const results = await Promise.all(configured.map((gate) => meets(gate, owner)));
      return results.some(Boolean);
    },

    // Ballots ('<chainId>:<contract>:<tokenId>') for the ERC-721 tokens this
    // wallet holds right now. Pass tokenIds (from an indexer or the client) to
    // skip enumeration; every id is checked with ownerOf, so they are never trusted.
    // Returns [] for a non-holder.
    // ERC-721 only: an ERC-1155 or ERC-20 balance can be split across wallets,
    // so it cannot name the one token behind a vote. Use isHolder plus a
    // snapshot for those (FEEDBACK-BOARD.md, 10.4).
    async ballotsFor(address, { tokenIds } = {}) {
      if (configured.some((gate) => gate.standard !== 'erc721')) {
        throw new Error('token gate: ballots need every gate to be erc721');
      }
      const owner = address.toLowerCase();
      const out = [];
      for (const gate of configured) {
        if (tokenIds) {
          const ids = [...new Set(tokenIds.map(String))].slice(0, maxBallots);
          const owned = await Promise.all(ids.map((id) => ownedBy(gate, owner, id)));
          ids.forEach((id, i) => { if (owned[i]) out.push(ballot(gate, BigInt(id))); });
        } else {
          for (const id of await enumerate(gate, owner)) out.push(ballot(gate, id));
        }
      }
      return out;
    },
  };
}
