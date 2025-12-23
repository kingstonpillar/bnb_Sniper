import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { securitySafety } from "./securitycheck2.js";

// Replace with your actual pair and token addresses
const PAIR_ADDRESS = "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253";
const TOKEN_ADDRESS = "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253"; // if same as pair

async function main() {
  console.log(`🔍 Checking security for pair: ${PAIR_ADDRESS}`);
  
  try {
    const isSafe = await securitySafety(PAIR_ADDRESS, TOKEN_ADDRESS);
    console.log(`\n✅ Security check result: ${isSafe ? "SAFE" : "UNSAFE"}`);
  } catch (err) {
    console.error("❌ Error during security check:", err);
  }
}

main();