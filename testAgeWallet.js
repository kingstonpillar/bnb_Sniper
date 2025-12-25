import { walletRate } from "./walletRate.js"; // adjust the path if needed
import chalk from "chalk"; // for colorized output

async function runTest() {
  const tokens = [
    "0xca9deb6ff27a3b86905a8bf70c613a1bc6d89cc2",
    "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253"
  ];

  console.log(chalk.blue.bold("Checking wallet health for tokens:\n"));
  console.log(tokens.join("\n"), "\n");

  try {
    const results = await walletRate(tokens);

    results.forEach(r => {
      if (r.health === "healthy") {
        console.log(
          chalk.green.bold(`✔ ${r.token}`),
          `| Dev: ${r.dev}`,
          `| Age: ${r.walletAgeMinutes.toFixed(2)} min`,
          `| Score: ${r.score}`,
          `| Whitelisted: ${r.whitelisted}`
        );
      } else if (r.health === "unhealthy") {
        console.log(
          chalk.red.bold(`✖ ${r.token}`),
          `| Dev: ${r.dev || "unknown"}`,
          `| Age: ${r.walletAgeMinutes?.toFixed(2) || "-" } min`,
          `| Score: ${r.score || "-"}`,
          `| Whitelisted: ${r.whitelisted || false}`,
          r.error ? `| Error: ${r.error}` : ""
        );
      }
    });

  } catch (err) {
    console.error(chalk.red("Test failed:"), err.message || err);
  }
}

runTest();