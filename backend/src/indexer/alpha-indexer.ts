import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { ALPHA_ABI, ALPHA_LEGACY_ABI } from "../config.js";
import type { SignalStats, Trade } from "../domain/types.js";
import type { AlphaGateway } from "../chain/alpha-gateway.js";

type StreamEvent =
  | { event: "trade"; signalId: number; data: Trade }
  | { event: "opened"; signalId: number; data: { at: number } }
  | { event: "stampede"; signalId: number; data: { claims: number; window: string } };

interface SignalIndex {
  publishedAt: number | null;
  trades: Trade[];
  openedAt: number | null;
  blockNumber: number | null;
}

const emptyIndex = (): SignalIndex => ({ publishedAt: null, trades: [], openedAt: null, blockNumber: null });
const eventKey = (log: any) => `${log.transactionHash ?? "pending"}:${log.logIndex ?? 0}:${log.eventName}`;

export class AlphaIndexer {
  private readonly state = new Map<number, SignalIndex>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(event: StreamEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private cursor: bigint | null = null;
  private syncing = false;

  constructor(
    private readonly gateway: AlphaGateway,
    private readonly freeClaimsPath: string,
  ) {
    this.loadFreeClaims();
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StreamEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async start() {
    if (this.timer) return; // 已经起来了；重试路径不能叠出第二个轮询定时器
    const latest = await this.gateway.publicClient.getBlockNumber();
    const configured = process.env.DEPLOYMENT_BLOCK?.trim();
    const start = configured
      ? BigInt(configured)
      : BigInt(this.gateway.deployments.deploymentBlock ?? (this.gateway.net.key === "local-anvil" ? 0 : Number(latest)));
    if (!configured && this.gateway.deployments.deploymentBlock == null && this.gateway.net.key !== "local-anvil") {
      console.warn("[indexer] 未配置 DEPLOYMENT_BLOCK/deploymentBlock，本次只能从当前块开始；重启后历史聚合可能不完整");
    }
    this.cursor = start;
    this.timer = setInterval(() => void this.poll(), 1_000);
    this.timer.unref();
    await this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll() {
    if (this.syncing || this.cursor === null) return;
    this.syncing = true;
    try {
      const latest = await this.gateway.publicClient.getBlockNumber();
      if (latest >= this.cursor) {
        await this.syncRange(this.cursor, latest);
        this.cursor = latest + 1n;
      }
    } catch (error) {
      console.error("[indexer] poll failed", error);
    } finally {
      this.syncing = false;
    }
  }

  private async syncRange(fromBlock: bigint, toBlock: bigint) {
    if (toBlock < fromBlock) return;
    const chunkSize = 2_000n;
    for (let from = fromBlock; from <= toBlock; from += chunkSize) {
      const to = from + chunkSize - 1n > toBlock ? toBlock : from + chunkSize - 1n;
      const [published, bought, claimed, opened, legacyPublished, legacyBought, legacyOpened] = await Promise.all([
        this.logs(ALPHA_ABI, "Published", from, to),
        this.logs(ALPHA_ABI, "Bought", from, to),
        this.logs(ALPHA_ABI, "Claimed", from, to),
        this.logs(ALPHA_ABI, "Opened", from, to),
        this.logs(ALPHA_LEGACY_ABI, "Published", from, to),
        this.logs(ALPHA_LEGACY_ABI, "Bought", from, to),
        this.logs(ALPHA_LEGACY_ABI, "Opened", from, to),
      ]);
      const logs = [...published, ...bought, ...claimed, ...opened, ...legacyPublished, ...legacyBought, ...legacyOpened];
      logs.sort((a: any, b: any) => {
        const block = Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n);
        return block || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
      });
      for (const log of logs) this.ingest(log);
    }
  }

  private async logs(abi: readonly unknown[], eventName: string, fromBlock: bigint, toBlock: bigint): Promise<any[]> {
    return (await this.gateway.publicClient.getContractEvents({
      address: this.gateway.alpha,
      abi: abi as any,
      eventName: eventName as any,
      fromBlock,
      toBlock,
      strict: true,
    })) as any[];
  }

  private getIndex(id: number): SignalIndex {
    let index = this.state.get(id);
    if (!index) {
      index = emptyIndex();
      this.state.set(id, index);
    }
    return index;
  }

  private ingest(log: any) {
    const key = eventKey(log);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const args = log.args ?? {};
    const id = Number(args.id);
    if (!Number.isInteger(id) || id < 1) return;
    const index = this.getIndex(id);
    const blockNumber = log.blockNumber == null ? null : Number(log.blockNumber);
    index.blockNumber = Math.max(index.blockNumber ?? 0, blockNumber ?? 0) || null;

    if (log.eventName === "Published") {
      index.publishedAt = args.at == null ? index.publishedAt : Number(args.at);
      return;
    }
    if (log.eventName === "Opened") {
      const at = args.at == null ? Math.floor(Date.now() / 1000) : Number(args.at);
      index.openedAt = at;
      this.emit({ event: "opened", signalId: id, data: { at } });
      return;
    }
    if (log.eventName !== "Bought" && log.eventName !== "Claimed") return;

    const elapsed = Number(args.elapsed ?? 0);
    const price = log.eventName === "Claimed" ? 0n : BigInt(args.price ?? 0);
    const channel: Trade["channel"] =
      log.eventName === "Claimed" ? "free" : args.viaX402 ? "x402" : "onchain";
    const buyer = args.buyer as Address;
    if (index.trades.some((trade) => trade.buyer.toLowerCase() === buyer.toLowerCase())) return;
    const trade: Trade = {
      rank: index.trades.length + 1,
      buyer,
      label: buyer.slice(2, 6),
      priceMicro: price,
      elapsed,
      at: (index.publishedAt ?? Math.floor(Date.now() / 1000) - elapsed) + elapsed,
      channel,
      txHash: (log.transactionHash as Hex | null) ?? null,
      blockNumber,
    };
    index.trades.push(trade);
    this.emit({ event: "trade", signalId: id, data: trade });
  }

  recordFreeClaim(id: number, buyer: Address, publishedAt: number, at: number): Trade {
    const index = this.getIndex(id);
    const existing = this.findTrade(id, buyer);
    if (existing) return existing;
    index.publishedAt ??= publishedAt;
    const trade: Trade = {
      rank: this.stats(id).trades.length + 1,
      buyer,
      label: buyer.slice(2, 6),
      priceMicro: 0n,
      elapsed: Math.max(0, at - publishedAt),
      at,
      channel: "free",
      txHash: null,
      blockNumber: index.blockNumber,
    };
    index.trades.push(trade);
    mkdirSync(dirname(this.freeClaimsPath), { recursive: true });
    appendFileSync(this.freeClaimsPath, `${JSON.stringify({ ...trade, priceMicro: "0", signalId: id })}\n`, { mode: 0o600 });
    this.emit({ event: "trade", signalId: id, data: trade });
    const claims = index.trades.filter((row) => row.channel === "free").length;
    this.emit({ event: "stampede", signalId: id, data: { claims, window: "3s" } });
    return trade;
  }

  findTrade(id: number, buyer: Address): Trade | undefined {
    return this.stats(id).trades.find((trade) => trade.buyer.toLowerCase() === buyer.toLowerCase());
  }

  stats(id: number): SignalStats {
    const index = this.getIndex(id);
    const trades = [...index.trades]
      .sort((a, b) => a.at - b.at || (a.blockNumber ?? 0) - (b.blockNumber ?? 0))
      .map((trade, rank) => ({ ...trade, rank: rank + 1 }));
    const paid = trades.filter((trade) => trade.channel !== "free");
    const values = paid.map((trade) => trade.priceMicro);
    const maxPaid = values.length ? values.reduce((a, b) => (a > b ? a : b)) : null;
    const minPaid = values.length ? values.reduce((a, b) => (a < b ? a : b)) : null;
    const revenue = paid.reduce((sum, trade) => sum + trade.priceMicro, 0n);
    const spread = values.length >= 2 && minPaid !== null && minPaid > 0n && maxPaid !== null
      ? Number((maxPaid * 100n) / minPaid) / 100
      : null;
    return {
      buyers: paid.length,
      claims: trades.length - paid.length,
      revenue,
      maxPaid,
      minPaid,
      spread,
      trades,
      recent: trades.slice(-50).reverse(),
      openedAt: index.openedAt,
      blockNumber: index.blockNumber,
    };
  }

  private loadFreeClaims() {
    if (!existsSync(this.freeClaimsPath)) return;
    for (const line of readFileSync(this.freeClaimsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Trade & { signalId: number; priceMicro: string };
        const index = this.getIndex(row.signalId);
        if (index.trades.some((trade) => trade.buyer.toLowerCase() === row.buyer.toLowerCase())) continue;
        index.trades.push({ ...row, priceMicro: BigInt(row.priceMicro) });
      } catch {
        // 单条损坏不阻塞启动；后续链上事件仍可重建其余状态。
      }
    }
  }
}
