// ethermock.js

export class MockProvider {
  constructor() { }
}

export class MockWallet {
  constructor() {
    this.address = "0xMOCK_WALLET";
  }
}

export class MockContract {
  constructor(address, abi, walletOrProvider) {
    this.address = address;
    this.abi = abi;
    this.walletOrProvider = walletOrProvider;

    this._balances = { "0xMOCK_WALLET": 100n };
    this._allowances = {};
  }

  async balanceOf(addr) {
    return this._balances[addr] ?? 0n;
  }

  async approve(spender, amount) {
    this._allowances[spender] = amount;
    return { wait: async () => {} };
  }

  async allowance(owner, spender) {
    return this._allowances[spender] ?? 0n;
  }

  async getAmountsOut(amountIn, path) {
    // just return amountOut equal to amountIn for testing
    return [amountIn, amountIn];
  }

  async swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline, options) {
    return {
      hash: "0xMOCK_TX_HASH",
      wait: async () => {},
    };
  }
}