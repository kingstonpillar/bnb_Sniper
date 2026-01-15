// file: env.js
import "dotenv/config";
import { ethers } from "ethers";

function reqEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normAddress(value, nameForError) {
  try {
    return ethers.getAddress(String(value || "").trim()).toLowerCase();
  } catch {
    throw new Error(`Invalid address for ${nameForError}: ${value}`);
  }
}

export const WBNB = normAddress(reqEnv("WBNB_ADDRESS"), "WBNB_ADDRESS");
export const PANCAKE_FACTORY = normAddress(reqEnv("PANCAKE_FACTORY"), "PANCAKE_FACTORY");
export const PANCAKE_ROUTER = normAddress(reqEnv("PANCAKE_ROUTER"), "PANCAKE_ROUTER");