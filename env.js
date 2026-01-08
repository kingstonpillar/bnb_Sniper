// env.js
import "dotenv/config";

export const WBNB = process.env.WBNB_ADDRESS;
export const PANCAKE_FACTORY = process.env.PANCAKE_FACTORY;
export const PANCAKE_ROUTER = process.env.PANCAKE_ROUTER;

// Optional safety logs
if (!WBNB) console.error("❌ ERROR: WBNB_ADDRESS missing in .env");
if (!PANCAKE_FACTORY) console.error("❌ ERROR: PANCAKE_FACTORY missing in .env");
if (!PANCAKE_ROUTER) console.error("❌ ERROR: PANCAKE_ROUTER missing in .env");