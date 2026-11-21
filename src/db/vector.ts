import { db, getSqlAdapter } from './index';
import { getBM25Index } from '@/lib/bm25';
import { createKnowledgeSourceKey, parseKnowledgeSourceKey } from '@/types/knowledge';

export function normalizeVectorDocumentKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return parseKnowledgeSourceKey(normalized)
    ? normalized
    : createKnowledgeSourceKey('article', normalized);
}

// 向量数据库表结构定义
export interface VectorDocument {
  id: number;
  filename: string;   // 文件名
  chunk_id: number;   // 分块ID
  content: string;    // 分块内容
  embedding: string;  // 存储为JSON字符串的向量
  updated_at: number; // 时间戳
}

export type VectorDocumentSnapshot = Omit<VectorDocument, 'id'>;

export interface VectorIndexStats {
  documentCount: number;
  chunkCount: number;
  bm25DocumentCount: number;
  bm25ChunkCount: number;
  lastUpdatedAt: number | null;
}

export interface VectorIndexSummary {
  filename: string;
  updated_at: number;
}

// 向量缓存项
interface CachedVector {
  id: number;
  filename: string;
  chunk_id: number;
  content: string;
  embedding: number[];  // 解析后的向量
  updated_at: number;
}

// 向量缓存管理
class VectorCache {
  private cache: Map<number, CachedVector> = new Map();
  private vectorsByFilename: Map<string, number[]> = new Map(); // 文件名到向量ID列表的映射
  private lastUpdate: number = 0;
  private cacheVersion: number = 0;

  // 获取缓存版本号，用于判断缓存是否过期
  getVersion(): number {
    return this.cacheVersion;
  }

  // 从缓存获取所有向量
  getAll(): CachedVector[] {
    return Array.from(this.cache.values());
  }

  // 按文件名获取向量
  getByFilename(filename: string): CachedVector[] {
    const ids = this.vectorsByFilename.get(filename) || [];
    return ids.map(id => this.cache.get(id)).filter(Boolean) as CachedVector[];
  }

  // 更新缓存
  async update() {
    const docs = await db.select<VectorDocument[]>(`
      select id, filename, chunk_id, content, embedding, updated_at from vector_documents
    `);

    // 清空旧缓存
    this.cache.clear();
    this.vectorsByFilename.clear();

    // 构建新缓存
    for (const doc of docs) {
      try {
        const embedding = JSON.parse(doc.embedding) as number[];
        const cached: CachedVector = {
          id: doc.id,
          filename: doc.filename,
          chunk_id: doc.chunk_id,
          content: doc.content,
          embedding,
          updated_at: doc.updated_at
        };
        this.cache.set(doc.id, cached);

        // 按文件名索引
        if (!this.vectorsByFilename.has(doc.filename)) {
          this.vectorsByFilename.set(doc.filename, []);
        }
        this.vectorsByFilename.get(doc.filename)!.push(doc.id);
      } catch (error) {
        console.error(`Failed to parse embedding for doc ${doc.id}:`, error);
      }
    }

    this.lastUpdate = Date.now();
    this.cacheVersion++;
  }

  // 添加单个向量到缓存
  add(doc: VectorDocument) {
    try {
      const embedding = JSON.parse(doc.embedding) as number[];
      const cached: CachedVector = {
        id: doc.id,
        filename: doc.filename,
        chunk_id: doc.chunk_id,
        content: doc.content,
        embedding,
        updated_at: doc.updated_at
      };
      this.cache.set(doc.id, cached);

      if (!this.vectorsByFilename.has(doc.filename)) {
        this.vectorsByFilename.set(doc.filename, []);
      }
      const fileIds = this.vectorsByFilename.get(doc.filename)!;
      if (!fileIds.includes(doc.id)) {
        fileIds.push(doc.id);
      }
      this.cacheVersion++;
    } catch (error) {
      console.error(`Failed to add vector to cache for doc ${doc.id}:`, error);
    }
  }

  // 删除文件的所有向量
  deleteByFilename(filename: string) {
    const ids = this.vectorsByFilename.get(filename) || [];
    for (const id of ids) {
      this.cache.delete(id);
    }
    this.vectorsByFilename.delete(filename);
    this.cacheVersion++;
  }

  // 检查是否需要更新缓存（5分钟过期）
  // Re-key cached vectors after a file rename (K-01). Target entries
  // are replaced first, mirroring the old SQL delete-then-update.
  renameByFilename(oldFilename: string, newFilename: string) {
    const ids = this.vectorsByFilename.get(oldFilename) || [];
    if (ids.length === 0) return;
    this.deleteByFilename(newFilename);
    for (const id of ids) {
      const cached = this.cache.get(id);
      if (cached) cached.filename = newFilename;
    }
    this.vectorsByFilename.delete(oldFilename);
    this.vectorsByFilename.set(newFilename, ids);
    this.cacheVersion++;
  }

  // Re-key every cached filename under a renamed folder prefix (K-01).
  renameByPrefix(oldPrefix: string, newPrefix: string) {
    const keys = Array.from(this.vectorsByFilename.keys()).filter(
      key => key === oldPrefix || key.startsWith(`${oldPrefix}/`)
    );
    for (const key of keys) {
      this.renameByFilename(key, `${newPrefix}${key.slice(oldPrefix.length)}`);
    }
  }

  needsUpdate(): boolean {
    return Date.now() - this.lastUpdate > 5 * 60 * 1000 || this.cache.size === 0;
  }
}

// 全局向量缓存实例
const vectorCache = new VectorCache();

// 初始化向量数据库表
let vectorDbInitPromise: Promise<void> | null = null;

export async function initVectorDb() {
  if (!vectorDbInitPromise) {
    vectorDbInitPromise = (async () => {
      await db.execute(`
        create table if not exists vector_documents (
          id integer primary key autoincrement,
          filename text not null,
          chunk_id integer not null,
          content text not null,
          embedding text not null,
          updated_at integer not null,
          unique(filename, chunk_id)
        )
      `);

      // 创建用于快速查找文件的索引
      await db.execute(`
        create index if not exists idx_vector_documents_filename
        on vector_documents(filename)
      `);

      // 旧版仅存 Markdown 路径。增加 article: 前缀即可完成来源迁移，
      // 向量本身不变，因此不会产生新的 Embedding 请求。
      await db.execute(`
        update vector_documents
        set filename = 'article:' || filename
        where filename not like 'article:%'
          and filename not like 'record:%'
          and filename not like 'canvas:%'
      `);

      // 初始化缓存。应用启动期间可能从多个入口调用初始化，确保只加载一次。
      await vectorCache.update();
    })().catch((error) => {
      vectorDbInitPromise = null;
      throw error;
    });
  }

  await vectorDbInitPromise;
}

export async function getAllVectorDocuments(): Promise<VectorDocumentSnapshot[]> {
  return await db.select<VectorDocumentSnapshot[]>(`
    select filename, chunk_id, content, embedding, updated_at
    from vector_documents
    order by filename, chunk_id
  `);
}

export async function getVectorIndexSummaries(): Promise<VectorIndexSummary[]> {
  // Migrated to catalog kind `vector.summaries` (UTANG-UJI-05): the
  // legacy `db` facade always rejects in web mode. Catalog rows split
  // the upstream filename into (sourceType, sourceId); map back to the
  // legacy {filename, updated_at} shape callers read.
  const rows = await getSqlAdapter().query({ kind: 'vector.summaries' });
  return rows.map(row => ({
    filename: createKnowledgeSourceKey(row.sourceType, row.sourceId),
    updated_at: row.updatedAt,
  }));
}

export async function getVectorIndexStats(): Promise<VectorIndexStats> {
  // Derived from `vector.summaries` (UTANG-UJI-05): summaries carry no
  // chunk counts, so chunkCount is reported as 0 until a stats kind
  // exists in the catalog.
  const summaries = await getVectorIndexSummaries();
  const bm25Stats = getBM25Index()?.getStats();
  return {
    documentCount: summaries.length,
    chunkCount: 0,
    bm25DocumentCount: bm25Stats?.documentCount || 0,
    bm25ChunkCount: bm25Stats?.chunkCount || 0,
    lastUpdatedAt: summaries.length > 0
      ? Math.max(...summaries.map(summary => summary.updated_at))
      : null
  };
}

async function insertVectorDocumentSnapshots(documents: VectorDocumentSnapshot[]): Promise<void> {
  for (const document of documents) {
    await db.execute(
      `insert into vector_documents
        (filename, chunk_id, content, embedding, updated_at)
       values ($1, $2, $3, $4, $5)`,
      [
        normalizeVectorDocumentKey(document.filename),
        document.chunk_id,
        document.content,
        document.embedding,
        document.updated_at,
      ]
    );
  }
}

export async function replaceAllVectorDocuments(documents: VectorDocumentSnapshot[]): Promise<void> {
  // tauri-plugin-sql may execute successive statements on different pooled
  // connections, so a manual BEGIN here can lock the following DELETE. Keep a
  // complete recovery snapshot instead and restore it if replacement fails.
  const previousDocuments = await getAllVectorDocuments();

  try {
    await db.execute('delete from vector_documents');
    await insertVectorDocumentSnapshots(documents);
    await vectorCache.update();
  } catch (error) {
    await db.execute('delete from vector_documents');
    await insertVectorDocumentSnapshots(previousDocuments);
    await vectorCache.update();
    throw error;
  }
}

export async function replaceVectorDocumentsByFilename(
  filename: string,
  documents: VectorDocumentSnapshot[]
): Promise<void> {
  const normalizedFilename = normalizeVectorDocumentKey(filename)
  const previousDocuments = await getVectorDocumentsByFilename(normalizedFilename)
  try {
    await db.execute('delete from vector_documents where filename = $1', [normalizedFilename])
    await insertVectorDocumentSnapshots(documents.map(document => ({
      ...document,
      filename: normalizedFilename,
    })))
    await vectorCache.update()
  } catch (error) {
    await db.execute('delete from vector_documents where filename = $1', [normalizedFilename])
    await insertVectorDocumentSnapshots(previousDocuments.map(({ filename, chunk_id, content, embedding, updated_at }) => ({
      filename,
      chunk_id,
      content,
      embedding,
      updated_at,
    })))
    await vectorCache.update()
    throw error
  }
}

// 插入或更新向量文档
export async function upsertVectorDocument(doc: Omit<VectorDocument, 'id'>) {
  const filename = normalizeVectorDocumentKey(doc.filename);
  await db.execute(
    "insert into vector_documents (filename, chunk_id, content, embedding, updated_at) values ($1, $2, $3, $4, $5) on conflict(filename, chunk_id) do update set content = excluded.content, embedding = excluded.embedding, updated_at = excluded.updated_at",
    [filename, doc.chunk_id, doc.content, doc.embedding, doc.updated_at]);

  // 获取插入的文档ID并更新缓存
  const inserted = await db.select<VectorDocument[]>(
    "select * from vector_documents where filename = $1 and chunk_id = $2",
    [filename, doc.chunk_id]
  );

  if (inserted.length > 0) {
    vectorCache.add(inserted[0]);
  }
}

// 获取指定文件名的所有向量文档
export async function getVectorDocumentsByFilename(filename: string) {
  const normalizedFilename = normalizeVectorDocumentKey(filename);
  return await db.select<VectorDocument[]>(
    "select * from vector_documents where filename = $1 order by chunk_id",
    [normalizedFilename]);
}

/** Aggregate only this folder's known notes without loading embedding payloads. */
export async function getVectorIndexStatsForFiles(filenames: readonly string[]): Promise<{
  documentCount: number;
  chunkCount: number;
  lastUpdatedAt: number | null;
}> {
  // Derived from `vector.summaries` (UTANG-UJI-05): the catalog has no
  // per-file stats kind, and summaries carry no chunk counts, so
  // chunkCount is reported as 0 until a stats kind exists.
  const keys = new Set(filenames.map(normalizeVectorDocumentKey));
  const summaries = await getVectorIndexSummaries();
  const matched = summaries.filter(summary => keys.has(summary.filename));
  return {
    documentCount: matched.length,
    chunkCount: 0,
    lastUpdatedAt: matched.length > 0
      ? Math.max(...matched.map(summary => summary.updated_at))
      : null,
  };
}

// 通过文件名删除向量文档
export async function deleteVectorDocumentsByFilename(filename: string) {
  const normalizedFilename = normalizeVectorDocumentKey(filename);
  await db.execute(
    "delete from vector_documents where filename = $1",
    [normalizedFilename]);

  // 从缓存中删除
  vectorCache.deleteByFilename(normalizedFilename);
  getBM25Index()?.deleteByFilename(normalizedFilename);
}

export async function renameVectorDocumentsByFilename(oldFilename: string, newFilename: string) {
  const normalizedOldFilename = normalizeVectorDocumentKey(oldFilename);
  const normalizedNewFilename = normalizeVectorDocumentKey(newFilename);
  if (normalizedOldFilename === normalizedNewFilename) return;
  // K-01: the legacy `db` facade always rejects in this fork, so the
  // old SQL rename threw after the disk rename had already succeeded
  // and broke rename/move in the file tree (single rename showed a
  // raw error; batch move rolled back and the rollback threw too).
  // Persistent chunks cannot exist yet in Fase 1 (the only chunk
  // write kind, vector.replaceChunks, is a Fase 2 stub), so only the
  // in-memory indexes are re-keyed here. Persistent chunk rename
  // lands with the Fase 2 vector write path.
  getBM25Index()?.renameFilename(normalizedOldFilename, normalizedNewFilename);
  vectorCache.renameByFilename(normalizedOldFilename, normalizedNewFilename);
}

export async function deleteVectorDocumentsByPrefix(prefix: string) {
  const normalizedPrefix = normalizeVectorDocumentKey(prefix);
  await db.execute(
    'delete from vector_documents where filename = $1 or filename like $2',
    [normalizedPrefix, `${normalizedPrefix}/%`]
  );
  getBM25Index()?.deleteByFilenamePrefix(normalizedPrefix);
  await vectorCache.update();
}

export async function renameVectorDocumentsByPrefix(oldPrefix: string, newPrefix: string) {
  const normalizedOldPrefix = normalizeVectorDocumentKey(oldPrefix);
  const normalizedNewPrefix = normalizeVectorDocumentKey(newPrefix);
  if (normalizedOldPrefix === normalizedNewPrefix) return;
  // K-01: same legacy-facade removal as renameVectorDocumentsByFilename
  // above. Folder rename and drag move call this after the disk move
  // succeeds; it must not throw. Only the in-memory indexes are
  // re-keyed in Fase 1; persistent chunk rename is Fase 2 work.
  getBM25Index()?.renameFilenamePrefix(normalizedOldPrefix, normalizedNewPrefix);
  vectorCache.renameByPrefix(normalizedOldPrefix, normalizedNewPrefix);
}

// 检查文件是否已存在于向量数据库中
export async function checkVectorDocumentExists(filename: string) {
  const normalizedFilename = normalizeVectorDocumentKey(filename);
  const result = await db.select<{ count: number }[]>(
    "select count(*) as count from vector_documents where filename = $1",
    [normalizedFilename]);
  
  return result[0]?.count > 0;
}

// 获取最相似的文档片段（优化版本：使用缓存）
export async function getSimilarDocuments(
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.7,
  allowedFilenames?: ReadonlySet<string>
): Promise<{id: number, filename: string, chunk_id: number, content: string, similarity: number}[]> {
  // 检查是否需要更新缓存
  if (vectorCache.needsUpdate()) {
    await vectorCache.update();
  }

  // 从缓存获取所有向量（已解析，避免重复 JSON.parse）
  const cachedVectors = vectorCache.getAll().filter(
    doc => !allowedFilenames || allowedFilenames.has(doc.filename)
  );

  if (!cachedVectors.length) return [];

  // 计算余弦相似度并排序
  const allSimilarities = cachedVectors.map(doc => {
    const similarity = cosineSimilarity(queryEmbedding, doc.embedding);

    return {
      id: doc.id,
      filename: doc.filename,
      chunk_id: doc.chunk_id,
      content: doc.content,
      similarity
    };
  });

  const results = allSimilarities
  .filter(doc => doc.similarity >= threshold)
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, limit);

  return results;
}

// 余弦相似度计算
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vector dimensions do not match.');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 清空向量数据库
export async function clearVectorDb() {
  // Migrated to kind `vector.clear` (BUG-03): the server owns
  // vector_chunks; the legacy `db` facade always rejects in
  // web mode. Cache cleanup below stays client-side.
  await getSqlAdapter().execute({ kind: 'vector.clear' });

  // 清空缓存
  await vectorCache.update();
  getBM25Index()?.clear();
}

// 获取所有向量文档的文件名列表
export async function getAllVectorDocumentFilenames() {
  return await db.select<{filename: string}[]>(`
    select distinct filename from vector_documents
  `);
}

// 手动刷新向量缓存
export async function refreshVectorCache() {
  await vectorCache.update();
}
