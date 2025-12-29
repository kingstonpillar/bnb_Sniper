import Web3 from "web3";
import { keccak256 } from "web3-utils";
import dotenv from "dotenv";
dotenv.config(); // loads .env

const TIMESTAMP_OPCODE = "42"; // block.timestamp opcode

function hasSelector(bytecode, signature) {
  const selector = keccak256(signature).slice(2, 10);
  return bytecode.includes(selector);
}

function hasAnySelector(bytecode, sigs) {
  return sigs.some(sig => hasSelector(bytecode, sig));
}

export async function delayedRugCheck(token) {
  // ✅ Use RPC from .env automatically
  const forkRpc = process.env.FORK_RPC;
  if (!forkRpc) throw new Error("FORK_RPC not set in .env");

  const web3 = new Web3(forkRpc);
  const code = await web3.eth.getCode(token);

  if (!code || code === "0x") {
    return { ok: false, reason: "no bytecode" };
  }

  const taxSetter = hasAnySelector(code, [
    "setTax(uint256)",
    "setFee(uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "updateFees(uint256,uint256)"
  ]);

  const routerMutable = hasAnySelector(code, [
    "setRouter(address)",
    "updateRouter(address)",
    "changeRouter(address)"
  ]);

  const tradingKill = hasAnySelector(code, [
    "pause()",
    "unpause()",
    "setTradingEnabled(bool)",
    "disableTrading()",
    "enableTrading(bool)"
  ]);

  const shadowOwner = hasAnySelector(code, [
    "setAdmin(address)",
    "grantRole(bytes32,address)",
    "transferOwnership(address)",
    "setOperator(address)"
  ]);

  const timeBomb = code.includes(TIMESTAMP_OPCODE);

  let score = 0;
  if (taxSetter) score += 15;
  if (routerMutable) score += 20;
  if (tradingKill) score += 25;
  if (shadowOwner) score += 20;
  if (timeBomb && taxSetter) score += 25;

  const verdict =
    score >= 60 ? "DELAYED_RUG_LIKELY" :
    score >= 40 ? "HIGH_RISK" :
    score >= 20 ? "CAUTION" :
    "LOW_RISK";

  return {
    ok: true,
    verdict,
    score,
    flags: { taxSetter, routerMutable, tradingKill, shadowOwner, timeBomb }
  };
}