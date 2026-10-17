import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";
import { fmtUsdc } from "../../../shared/curve.mjs";

export interface QuoteRecord {
  quoteId: string;
  signalId: number;
  amountMicro: string;
  priceAt: number;
  expiresAt: number;
  createdAt: number;
  network: string;
  asset: Address;
  payTo: Address;
}

export class QuoteStore {
  private readonly values = new Map<string, QuoteRecord>();

  constructor(
    private readonly path: string,
    private readonly ttlSeconds = 10,
    private readonly retentionSeconds = 600,
  ) {
    this.load();
  }

  create(input: {
    signalId: number;
    amountMicro: bigint;
    now: number;
    network: string;
    asset: Address;
    payTo: Address;
  }): QuoteRecord {
    this.purge(input.now);
    const quote: QuoteRecord = {
      quoteId: `q_${randomBytes(8).toString("hex")}`,
      signalId: input.signalId,
      amountMicro: input.amountMicro.toString(),
      priceAt: input.now,
      expiresAt: input.now + this.ttlSeconds,
      createdAt: input.now,
      network: input.network,
      asset: input.asset,
      payTo: input.payTo,
    };
    this.values.set(quote.quoteId, quote);
    this.flush();
    return quote;
  }

  get(quoteId: string, signalId: number, now = Math.floor(Date.now() / 1000)): QuoteRecord | undefined {
    this.purge(now);
    const quote = this.values.get(quoteId);
    return quote?.signalId === signalId ? quote : undefined;
  }

  active(signalId: number, now: number): QuoteRecord | undefined {
    this.purge(now);
    return [...this.values.values()]
      .filter((quote) => quote.signalId === signalId && quote.expiresAt >= now)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  toResponse(quote: QuoteRecord) {
    return {
      quoteId: quote.quoteId,
      signalId: quote.signalId,
      amount: fmtUsdc(quote.amountMicro),
      amountMicro: quote.amountMicro,
      priceAt: quote.priceAt,
      expiresAt: quote.expiresAt,
      network: quote.network,
      asset: quote.asset,
      payTo: quote.payTo,
    };
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const rows = JSON.parse(readFileSync(this.path, "utf8")) as QuoteRecord[];
      for (const quote of rows) this.values.set(quote.quoteId, quote);
      this.purge(Math.floor(Date.now() / 1000));
    } catch {
      this.values.clear();
    }
  }

  private purge(now: number) {
    let dirty = false;
    for (const [id, quote] of this.values) {
      if (quote.createdAt + this.retentionSeconds < now) {
        this.values.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...this.values.values()], null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
