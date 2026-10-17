import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";

export interface StoredContent {
  id: number;
  title: string;
  previewText: string;
  body: string;
  contentHash: Hex;
  source?: string;
  attestPublicSource?: boolean;
}

type LegacyContent = Omit<StoredContent, "previewText" | "contentHash"> & {
  preview?: string;
  previewText?: string;
  contentHash?: Hex;
};

export const hashContent = (body: string): Hex => keccak256(toBytes(body));

export class ContentStore {
  private readonly values = new Map<number, StoredContent>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    const rows = JSON.parse(readFileSync(this.path, "utf8")) as LegacyContent[];
    for (const row of rows) {
      const actualHash = hashContent(row.body);
      if (row.contentHash && row.contentHash.toLowerCase() !== actualHash.toLowerCase()) {
        throw new Error(`signal #${row.id} 的落盘正文与 contentHash 不一致`);
      }
      this.values.set(row.id, {
        id: row.id,
        title: row.title,
        previewText: row.previewText ?? row.preview ?? "",
        body: row.body,
        contentHash: row.contentHash ?? actualHash,
        source: row.source,
        attestPublicSource: row.attestPublicSource,
      });
    }
  }

  get(id: number): StoredContent | undefined {
    return this.values.get(id);
  }

  all(): StoredContent[] {
    return [...this.values.values()];
  }

  put(content: StoredContent) {
    if (hashContent(content.body).toLowerCase() !== content.contentHash.toLowerCase()) {
      throw new Error("正文 contentHash 校验失败");
    }
    this.values.set(content.id, content);
    this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.all(), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
