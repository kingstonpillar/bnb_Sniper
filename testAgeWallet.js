import { walletRate } from "./walletHistory.js";

const tokens = [
  "0xca9deb6ff27a3b86905a8bf70c613a1bc6d89cc2",
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253"
];

(async () => {
  console.log("Checking wallet health for tokens...");
  const results = await walletRate(tokens);
  console.log(JSON.stringify(results, null, 2));
})();