import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ALPHA_ABI, ALPHA_LEGACY_ABI, getDeployments, getNetwork, type Deployments, type NetConfig } from "../config.js";
import type { AccessRecord, ChainSignal } from "../domain/types.js";

/**
 * 等回执的上限。前端把 txHash 传上来时，如果那笔交易一直不被打包
 * （gas 太低、nonce 卡住、RPC 掉线），没有超时的 waitForTransactionReceipt
 * 会让这个 HTTP 请求永久挂着 —— 客户端只能等到自己超时，后端连接也一起占着。
 */
const RECEIPT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.TX_TIMEOUT_MS ?? 90_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
})();

/**
 * RPC 韧性参数。
 *
 * 公共节点（尤其 Monad 官方 testnet-rpc.monad.xyz）在并发下会直接
 * ECONNRESET 断连：一次失败的 eth_call 就会让 /api/signals 整个变成 502。
 * 所以在 transport 层统一做三件事：
 *   1. 单次请求超时，避免连接被吊死；
 *   2. 失败按指数退避重试（viem 内置 retryCount）；
 *   3. 主节点连续失败时自动切备用节点（fallback transport）。
 * 备用节点：MONAD_RPC_FALLBACKS（逗号分隔）> 内置默认列表。
 */
const RPC_RETRY_COUNT = (() => {
  const raw = Number(process.env.RPC_RETRY ?? 4);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4;
})();

const RPC_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RPC_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

/** 只在这些网络上兜底换节点；本地 anvil 没有公共节点可换。 */
const DEFAULT_RPC_FALLBACKS: Record<string, string[]> = {
  "monad-testnet": ["https://10143.rpc.thirdweb.com", "https://rpc.ankr.com/monad_testnet"],
};

function transportFor(url: string) {
  return http(url, { retryCount: RPC_RETRY_COUNT, retryDelay: 300, timeout: RPC_TIMEOUT_MS });
}

function rpcTransport(net: NetConfig) {
  const envList = (process.env.MONAD_RPC_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const extra = envList.length > 0 ? envList : (DEFAULT_RPC_FALLBACKS[net.key] ?? []);
  const urls = [net.rpcUrl, ...extra.filter((u) => u !== net.rpcUrl)];
  return urls.length === 1 ? transportFor(urls[0]!) : fallback(urls.map(transportFor), { rank: false });
}

export class AlphaGateway {
  readonly net: NetConfig;
  readonly deployments: Deployments;
  readonly alpha: Address;
  readonly publicClient: PublicClient;

  constructor() {
    this.net = getNetwork();
    this.deployments = getDeployments();
    this.alpha = this.deployments.alphaClock;
    this.publicClient = createPublicClient({ transport: rpcTransport(this.net) });
  }

  async assertNetwork() {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.net.chainId) {
      throw new Error(`RPC chainId=${chainId}，但 NETWORK=${this.net.key} 要求 ${this.net.chainId}`);
    }
    if (this.deployments.chainId !== chainId) {
      throw new Error(`deployments.json chainId=${this.deployments.chainId}，RPC chainId=${chainId}`);
    }
  }

  async blockTime(): Promise<number> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async blockNumber(): Promise<number> {
    return Number(await this.publicClient.getBlockNumber());
  }

  async signalCount(): Promise<number> {
    const value = await this.publicClient.readContract({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "signalCount",
    });
    return Number(value);
  }

  async readSignal(id: number): Promise<ChainSignal | null> {
    try {
      const value = (await this.publicClient.readContract({
        address: this.alpha,
        abi: ALPHA_ABI,
        functionName: "getSignal",
        args: [BigInt(id)],
      })) as any;
      if (!value?.publisher || value.publisher.toLowerCase() === zeroAddress) return null;
      return {
        id,
        publisher: value.publisher,
        publishedAt: Number(value.publishedAt),
        basePrice: BigInt(value.basePrice),
        floorPrice: BigInt(value.floorPrice),
        halfLife: Number(value.halfLife),
        forcedOpen: Boolean(value.forcedOpen),
        contentHash: value.contentHash,
        title: value.title,
        previewURI: value.previewURI,
      };
    } catch (v2Error) {
      try {
        const value = (await this.publicClient.readContract({
          address: this.alpha,
          abi: ALPHA_LEGACY_ABI,
          functionName: "getSignal",
          args: [BigInt(id)],
        })) as any;
        if (!value?.publisher || value.publisher.toLowerCase() === zeroAddress) return null;
        return {
          id,
          publisher: value.publisher,
          publishedAt: Number(value.publishedAt),
          basePrice: BigInt(value.basePrice),
          floorPrice: BigInt(value.floorPrice),
          halfLife: Number(value.halfLife),
          forcedOpen: Boolean(value.freeNow && BigInt(value.price) === 0n),
          contentHash: `0x${"0".repeat(64)}`,
          title: value.title,
          previewURI: value.previewURI,
        };
      } catch {
        throw v2Error;
      }
    }
  }

  async currentPrice(id: number): Promise<bigint> {
    const value = await this.publicClient.readContract({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "currentPrice",
      args: [BigInt(id)],
    });
    return BigInt(value);
  }

  async priceAt(id: number, timestamp: number): Promise<bigint> {
    const value = await this.publicClient.readContract({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "priceAt",
      args: [BigInt(id), BigInt(timestamp)],
    });
    return BigInt(value);
  }

  async accessOf(id: number, buyer: Address): Promise<AccessRecord> {
    try {
      const value = (await this.publicClient.readContract({
        address: this.alpha,
        abi: ALPHA_ABI,
        functionName: "accessOf",
        args: [BigInt(id), buyer],
      })) as any;
      return { at: Number(value.at), price: BigInt(value.price) };
    } catch (v2Error) {
      try {
        const [has, price] = await Promise.all([
          this.publicClient.readContract({
            address: this.alpha,
            abi: ALPHA_LEGACY_ABI,
            functionName: "hasAccess",
            args: [BigInt(id), buyer],
          }),
          this.publicClient.readContract({
            address: this.alpha,
            abi: ALPHA_LEGACY_ABI,
            functionName: "paidPrice",
            args: [BigInt(id), buyer],
          }),
        ]);
        return { at: has ? 1 : 0, price: BigInt(price) };
      } catch {
        throw v2Error;
      }
    }
  }

  async publish(input: {
    title: string;
    previewText: string;
    contentHash: Hex;
    basePrice: bigint;
    floorPrice: bigint;
    halfLife: number;
  }): Promise<{ id: number; txHash: Hex }> {
    const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
    if (!privateKey) throw new Error("缺少 PRIVATE_KEY，无法由后端代发 publish()");
    const account = privateKeyToAccount(privateKey);
    const args = [
      input.title,
      input.previewText,
      input.contentHash,
      input.basePrice,
      input.floorPrice,
      input.halfLife,
    ] as const;
    const estimate = await this.publicClient.estimateContractGas({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "publish",
      args,
      account,
    });
    const wallet = createWalletClient({ account, transport: http(this.net.rpcUrl) });
    const txHash = await wallet.writeContract({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "publish",
      args,
      gas: estimate + estimate / 10n,
      chain: null,
    });
    const id = await this.publishedId(txHash, input.contentHash);
    return { id, txHash };
  }

  async publishedId(txHash: Hex, expectedContentHash: Hex): Promise<number> {
    const receipt = await this.waitReceipt(txHash);
    if (receipt.status !== "success") throw new Error("publish 交易执行失败");
    const logs = parseEventLogs({ abi: ALPHA_ABI, eventName: "Published", logs: receipt.logs, strict: true });
    const event = logs.find((log) => log.address.toLowerCase() === this.alpha.toLowerCase());
    if (!event) throw new Error("交易回执中没有 AlphaClock.Published 事件");
    if (event.args.contentHash.toLowerCase() !== expectedContentHash.toLowerCase()) {
      throw new Error("Published.contentHash 与正文不一致");
    }
    return Number(event.args.id);
  }

  async recordX402(id: number, buyer: Address, price: bigint): Promise<Hex> {
    const privateKey = (process.env.VERIFIER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex | undefined;
    if (!privateKey) throw new Error("缺少 VERIFIER_PRIVATE_KEY/PRIVATE_KEY，无法记录 x402 访问权");
    const account = privateKeyToAccount(privateKey);
    const args = [BigInt(id), buyer, price] as const;
    const estimate = await this.publicClient.estimateContractGas({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "recordX402",
      args,
      account,
    });
    const wallet = createWalletClient({ account, transport: http(this.net.rpcUrl) });
    const hash = await wallet.writeContract({
      address: this.alpha,
      abi: ALPHA_ABI,
      functionName: "recordX402",
      args,
      gas: estimate + estimate / 10n,
      chain: null,
    });
    const receipt = await this.waitReceipt(hash);
    if (receipt.status !== "success") throw new Error("recordX402 交易执行失败");
    return hash;
  }

  /** 带超时的 waitForTransactionReceipt，超时给一句人话而不是把请求挂死 */
  private async waitReceipt(hash: Hex) {
    try {
      return await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (error) {
      if (String((error as Error)?.name ?? "").includes("Timeout")) {
        throw new Error(`交易 ${hash.slice(0, 10)}… 在 ${RECEIPT_TIMEOUT_MS / 1000}s 内没有确认（可用 TX_TIMEOUT_MS 调整）`);
      }
      throw error;
    }
  }
}
