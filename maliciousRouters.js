// maliciousRouters.js
import { ethers } from "ethers";

const MALICIOUS_ROUTERS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x7d1bcd447e48f686e136a7db61d0b17a2373f09d",
  "0x8af8f7fa22366e29054569d83c2bb85e6227a456",
  "0x14361fa53089b972d1df6a2d88894b5f9b0e2b9f",
  "0xbF6FcF7107CDaE56Aa34dfF635f0d0d18a9EE056",
  "0x991a0f1bd51a1081eef55d260c300d14988cc5ce",
  "0x6fe56c0b0c277f1682659d1836143842165b07a1",
  "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  "0x10ed43c718714eb63d5aa57b78b54704e256024F",
  "0x05fF2B0DB69458A0750badebc4f9e13a5f16Ff72",
  "0xf9042c427bfec8d5b10b05d5cbdc5427a1f08f34",
  "0x94bc4c42fb70cfa00c8a90cab836f46189b9e585",
  "0xd99d1c33f9fC3444f8101754aBeD37515bC5c622",
  "0xf8db52ce695f52a324498bf398bf3954811c42ce",
  "0x8123c02b91436f629d796cf39ae03a5f38e230ff",
  "0xeD00fB3dA0B45b41E4ffEb9e5D61c01b4d5D5c6d",
  "0x0419af21bdb2b4eab8868386cea87d7ca5f623c1",
  "0xddc0b6872f58bbda6780dbdded44cf5b035aaa1e",
  "0x3c3af2f42b3f52f79c0b5cba5e8ba4b1a28fda57",
  "0x86b8f1e4a3c67d56edb5de3a2f3fa7d47e4f6b1f",
  "0x387cb6c89a83d17bf18495ef3a3684c3a72895e7",
  "0xadd0c4c01f3b5c8bce7d6c1c3536c3c648e96da5",
  "0x1d80cff2b776ff1f4206e59f782ca7eac560360b"
]);

const badPatterns = [
  "73656c6c",
  "63616e73656c6c",
  "73656c6c6c696d6974",
  "8da5cb5b",
  "f2fde38b",
  "d4ee1d90",
  "d5a02b23",
  "3ccfd60b",
  "ffffffffffffffffffffffffffffffff",
  "fd",
  "fe"
];

export async function scanRouter(routerAddress, provider) {
  const lower = routerAddress.toLowerCase();

  if (MALICIOUS_ROUTERS.has(lower)) {
    return { ok: false, score: 0, reason: "MALICIOUS_ROUTER_FOUND" };
  }

  const code = await provider.getCode(routerAddress);
  if (!code || code === "0x") {
    return { ok: false, score: 0, reason: "NO_CODE" };
  }

  const codeLow = code.toLowerCase();
  if (badPatterns.some(x => codeLow.includes(x))) {
    return { ok: false, score: 0, reason: "HONEYPOT_ROUTER_PATTERN" };
  }

  return { ok: true, score: 20, reason: "SAFE_ROUTER" };
}