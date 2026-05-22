import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

const raw = process.env.SOLANA_PRIVATE_KEY;
if (!raw) { console.error("SOLANA_PRIVATE_KEY not set in .env"); process.exit(1); }

let keypair;
try {
  keypair = Keypair.fromSecretKey(bs58.decode(raw));
} catch {
  keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

console.log("Public key:", keypair.publicKey.toString());
