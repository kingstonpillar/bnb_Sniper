// testLockedToken.js
import dotenv from "dotenv";
import { liquidityLock } from "./liquidityCheck.js";
import { ethers } from "ethers";

dotenv.config();

const TOKENS = [
  "0x8076c74c5e3f5852037f31ff0093eeb8c8add8d3", // SafeMoon
  "0xc748673057861a797275cd8a068abb95a902e8de"  // BabyDoge
];

(async () => {
  for (const t of TOKENS) {
    const token = ethers.getAddress(t);
    console.log(`\n Testing ${token}`);

    const res = await liquidityLock(token);
    console.log(res);
  }
})();