import { walletRate } from "./walletHistory.js";

const TOKEN = "0xca9deb6ff27a3b86905a8bf70c613a1bc6d89cc2";

(async () => {
  console.log("Checking wallet age...");
  const res = await walletRate(TOKEN);
  console.log(res);
})();