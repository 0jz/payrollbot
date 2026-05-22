/**
 * transfer.js
 * Sends SOL on devnet with auto-retry (3 attempts) and optional agent fee.
 * Agent takes 0.5% of every payment into its own wallet — this is how it earns.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";
import { getSolPrice, usdToLamports } from "./price.js";

const DEVNET_URL = "https://api.devnet.solana.com";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const AGENT_FEE_PCT = 0.005; // 0.5% — agent's cut on every payment

function getPayerKeypair() {
  const raw = process.env.SOLANA_PRIVATE_KEY;
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY is not set in .env");
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      throw new Error("SOLANA_PRIVATE_KEY must be base-58 or a JSON byte array.");
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a single SOL transfer with retry logic.
 * @private
 */
async function _sendWithRetry(connection, transaction, payer, attempt = 1) {
  try {
    return await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
    });
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    console.warn(
      `[transfer] Attempt ${attempt} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS}ms…`
    );
    await sleep(RETRY_DELAY_MS * attempt); // exponential back-off
    // Refresh blockhash before retry — old one may be expired
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    return _sendWithRetry(connection, transaction, payer, attempt + 1);
  }
}

/**
 * Send a USD-denominated payment on Solana devnet.
 * Automatically deducts a 0.5% agent fee and sends it to AGENT_WALLET if set.
 *
 * @param {string} recipientPublicKey
 * @param {number} usdAmount
 * @returns {Promise<TransferResult>}
 */
export async function sendSOL(recipientPublicKey, usdAmount) {
  if (!recipientPublicKey) throw new Error("recipientPublicKey is required");
  if (!usdAmount || usdAmount <= 0) throw new Error("usdAmount must be > 0");

  const connection = new Connection(DEVNET_URL, "confirmed");
  const payer = getPayerKeypair();
  const solPrice = await getSolPrice();

  // ── Fee split ────────────────────────────────────────────────
  const agentFeeUSD = usdAmount * AGENT_FEE_PCT;
  const freelancerUSD = usdAmount - agentFeeUSD;

  const lamports = usdToLamports(freelancerUSD, solPrice);
  const feeLamports = usdToLamports(agentFeeUSD, solPrice);
  const solAmount = lamports / LAMPORTS_PER_SOL;

  console.log(
    `[transfer] $${usdAmount} → freelancer $${freelancerUSD.toFixed(2)} + agent fee $${agentFeeUSD.toFixed(2)}`
  );

  // ── Validate addresses ──────────────────────────────────────
  let recipient;
  try {
    recipient = new PublicKey(recipientPublicKey);
  } catch {
    throw new Error(`Invalid Solana public key: "${recipientPublicKey}"`);
  }

  const agentWalletKey = process.env.AGENT_WALLET ?? "";
  const agentWallet = agentWalletKey ? (() => {
    try { return new PublicKey(agentWalletKey); } catch { return null; }
  })() : null;

  // ── Balance check ────────────────────────────────────────────
  const balance = await connection.getBalance(payer.publicKey);
  const totalNeeded = lamports + (agentWallet ? feeLamports : 0) + 10_000;
  if (balance < totalNeeded) {
    const has = (balance / LAMPORTS_PER_SOL).toFixed(4);
    const need = (totalNeeded / LAMPORTS_PER_SOL).toFixed(4);
    throw new Error(
      `Insufficient devnet SOL. Have ${has}, need ${need}. ` +
      `Go to https://faucet.solana.com and airdrop to ${payer.publicKey.toString()}`
    );
  }

  // ── Build transaction ────────────────────────────────────────
  const { blockhash } = await connection.getLatestBlockhash();
  const transaction = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });

  transaction.add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports })
  );

  // Agent fee transfer (only if AGENT_WALLET is configured)
  if (agentWallet && feeLamports > 0) {
    transaction.add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: agentWallet, lamports: feeLamports })
    );
    console.log(`[transfer] Agent fee: ${(feeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → ${agentWalletKey}`);
  }

  // ── Send with auto-retry ─────────────────────────────────────
  const signature = await _sendWithRetry(connection, transaction, payer);
  console.log(`[transfer] ✅ Confirmed (${MAX_RETRIES} max retries): ${signature}`);

  return {
    signature,
    solAmount,
    solPrice,
    lamports,
    agentFeeUSD: parseFloat(agentFeeUSD.toFixed(4)),
    feeLamports,
    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  };
}
