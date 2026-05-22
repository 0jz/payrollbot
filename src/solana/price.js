/**
 * price.js
 * Fetches live SOL/USD price from CoinGecko (free tier, no API key needed).
 * Falls back to a secondary endpoint if the first request fails.
 */

import axios from "axios";

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Simple in-memory cache — avoids hammering CoinGecko every 30 s
let _cache = { price: null, fetchedAt: 0 };
const CACHE_TTL_MS = 20_000; // 20 seconds

/**
 * Returns the current SOL price in USD.
 * @returns {Promise<number>}
 */
export async function getSolPrice() {
  const now = Date.now();
  if (_cache.price && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.price;
  }

  try {
    const { data } = await axios.get(COINGECKO_URL, { timeout: 8_000 });
    const price = data?.solana?.usd;
    if (!price || typeof price !== "number") {
      throw new Error("Unexpected CoinGecko response shape");
    }
    _cache = { price, fetchedAt: now };
    console.log(`[price] SOL/USD = $${price}`);
    return price;
  } catch (err) {
    // If cache is stale but exists, return it rather than crashing
    if (_cache.price) {
      console.warn(`[price] CoinGecko error — using stale cache ($${_cache.price}): ${err.message}`);
      return _cache.price;
    }
    throw new Error(`[price] Failed to fetch SOL price: ${err.message}`);
  }
}

/**
 * Converts a USD amount to lamports (smallest SOL unit).
 * 1 SOL = 1,000,000,000 lamports
 * @param {number} usdAmount
 * @param {number} solPrice  — result of getSolPrice()
 * @returns {number} lamports (integer)
 */
export function usdToLamports(usdAmount, solPrice) {
  const sol = usdAmount / solPrice;
  return Math.round(sol * 1_000_000_000);
}
