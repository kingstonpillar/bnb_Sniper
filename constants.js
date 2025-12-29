import fs from "fs";
import path from "path";

// Load locker ABIs dynamically from JSON files in the same folder
const UNCX_LOCKER_ABI = JSON.parse(fs.readFileSync(path.resolve("./unicryptLocker.json"), "utf8"));
const PINKLOCK_ABI = JSON.parse(fs.readFileSync(path.resolve("./pinklockV2.json"), "utf8"));
const TEAMFINANCE_LOCKER_ABI = JSON.parse(fs.readFileSync(path.resolve("./teamFinanceLocker.json"), "utf8"));

// Locker list with real addresses
export const LOCKER_ABIS = [
  {
    name: "Unicrypt (UNCX LP Locker)",
    address: "0xC765bddB93b0D1C1a88282BA0fa6B2d00E3E0C83",
    abi: UNCX_LOCKER_ABI
  },
  {
    name: "PinkLock V2 (PinkSale LP Locker)",
    address: "0x407993575c91Ce7643a4d4cCACc9A98c36eE1BBE",
    abi: PINKLOCK_ABI
  },
  {
    name: "Team Finance LP Locker",
    address: "0xe2fe530c047f2d85298b07d9333c05737f1435fb",
    abi: TEAMFINANCE_LOCKER_ABI
  }
];