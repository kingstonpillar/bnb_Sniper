import Web3 from "web3";
import PQueue from "p-queue";

const RPCS = [
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.defibit.io/"
];
let rpcIndex = 0;
function getWeb3() { return new Web3(RPCS[rpcIndex]); }
function switchRpc() { rpcIndex = (rpcIndex + 1) % RPCS.length; return getWeb3(); }

const queue = new PQueue({ concurrency: 5, interval: 1000, intervalCap: 5 });
let seenDevs = {};

async function safeCall(fn) {
    let web3 = getWeb3();
    try { return await fn(web3); }
    catch { web3 = switchRpc(); return await fn(web3); }
}

// ---------------- Detect Dev wallet from token creation ---------------- //
async function getDevWallet(tokenAddress) {
    return queue.add(async () => safeCall(async (web3) => {
        const code = await web3.eth.getCode(tokenAddress);
        if (code === "0x") throw new Error("Contract does not exist");

        const latestBlock = await web3.eth.getBlockNumber();
        for (let b = 0; b <= latestBlock; b++) {
            const block = await web3.eth.getBlock(b, true);
            if (!block || !block.transactions) continue;
            for (const tx of block.transactions) {
                if (tx.creates && tx.creates.toLowerCase() === tokenAddress.toLowerCase()) {
                    return tx.from.toLowerCase();
                }
            }
        }
        throw new Error("Dev wallet not found");
    }));
}

// ---------------- Helper Functions ---------------- //
async function getWalletAgeMinutes(dev) {
    return queue.add(async () => safeCall(async (web3) => {
        const latest = await web3.eth.getBlockNumber();
        for (let b = 1; b <= latest; b++) {
            const block = await web3.eth.getBlock(b, true);
            if (block.transactions.some(tx => tx.from.toLowerCase() === dev.toLowerCase() || (tx.to && tx.to.toLowerCase() === dev.toLowerCase()))) {
                const ts = block.timestamp;
                return (Date.now()/1000 - ts)/60;
            }
        }
        return 0;
    }));
}

function walletAgeMultiplier(minutes) {
    if (minutes < 1440) return 0;
    if (minutes < 10080) return 0.1;
    if (minutes < 43200) return 0.25;
    if (minutes < 129600) return 0.5;
    if (minutes < 259200) return 0.75;
    return 1.0;
}

function deployScore(deployCount) {
    if (deployCount === 1) return 10;
    if (deployCount <= 5) return 15;
    if (deployCount <= 20) return 20;
    return 25;
}

async function checkWhitelist(contractAddress, dev) {
    return queue.add(async () => safeCall(async (web3) => {
        try {
            const ABI = [{"constant":true,"inputs":[{"name":"addr","type":"address"}],"name":"isWhitelisted","outputs":[{"name":"","type":"bool"}],"type":"function"}];
            const contract = new web3.eth.Contract(ABI, contractAddress);
            return await contract.methods.isWhitelisted(dev).call();
        } catch { return false; }
    }));
}

// ---------------- Exported Async Batch Function ---------------- //
export async function walletRate(tokenAddresses) {
    if (!Array.isArray(tokenAddresses)) tokenAddresses = [tokenAddresses];

    const results = [];

    for (const tokenAddress of tokenAddresses) {
        try {
            const dev = await getDevWallet(tokenAddress);
            const walletAgeMinutes = await getWalletAgeMinutes(dev);
            const multiplier = walletAgeMultiplier(walletAgeMinutes);

            seenDevs[dev] = seenDevs[dev] || { deployCount: 0 };
            seenDevs[dev].deployCount++;

            let baseScore = deployScore(seenDevs[dev].deployCount);
            const whitelisted = await checkWhitelist(tokenAddress, dev);
            if (whitelisted) baseScore += 20;

            const finalScore = Math.round(baseScore * multiplier);

            let health = "unhealthy";
            if (multiplier >= 0.5 && finalScore >= 20) health = "healthy";

            results.push({
                dev,
                token: tokenAddress,
                walletAgeMinutes,
                multiplier,
                deployCount: seenDevs[dev].deployCount,
                whitelisted,
                baseScore,
                score: finalScore,
                health
            });
        } catch (err) {
            results.push({ token: tokenAddress, error: err.message, health: "unhealthy" });
        }
    }

    return results;
}