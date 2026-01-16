// file: testGoPlusLocks.js
import "dotenv/config";
import { getGoPlusLockDuration } from "./goplusLockDuration.js";

const lp = "0x453b2f93a28ddfdb1a6023a667817ffbf451d253"; // from your output

const knownLockers = [
  "0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8", // unicrypt
  "0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21", // dxlocker
  "0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe", // pinklock
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb"  // teamfinance
].map((x) => x.toLowerCase());

(async () => {
  const r = await getGoPlusLockDuration({
    chainId: 56,
    tokenOrLp: lp,
    knownLockers
  });

  console.log(JSON.stringify(r, null, 2));
})();