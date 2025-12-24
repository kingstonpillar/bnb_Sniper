// test/mocks/ethersMock.js
export class MockProvider {
  async getBlockNumber() { return 123456; }
}

export class MockWallet {
  constructor() {
    this.address = "0xMockWallet";
  }
}

export class MockContract {
  constructor(address, abi, signer) {
    this.address = address;
    this.signer = signer;
    this.allowanceValue = 0n;
    this.balanceValue = 1000000000000000000n; // 1 token
  }

  async balanceOf() {
    return this.balanceValue;
  }

  async allowance() {
    return this.allowanceValue;
  }

  async approve() {
    this.allowanceValue = this.balanceValue;
    return { wait: async () => true };
  }

  async getAmountsOut(amount) {
    return [amount, amount * 2n];
  }

  async swapExactTokensForETH() {
    return {
      hash: "0xMOCK_TX_HASH",
      wait: async () => true
    };
  }
}