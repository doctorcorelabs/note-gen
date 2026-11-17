import { getSqlAdapter } from './index'

export interface ImageAnalysisCacheEntry {
  cacheKey: string
  imageHash: string
  queryHash: string
  ocrText?: string
  visualAnalysis?: string
  mimeType?: string
  width?: number
  height?: number
  updatedAt: number
}

export async function getImageAnalysisCache(cacheKey: string): Promise<ImageAnalysisCacheEntry | undefined> {
  // Migrated to kind `imageCache.get` in wave 4 (W4-CODEMOD).
  // Expired rows are a miss server-side and never returned.
  // The kind row carries an extra `expiresAt`; it is stripped
  // here so callers keep seeing the upstream entry shape.
  const row = await getSqlAdapter().queryOne({ kind: 'imageCache.get', cacheKey })
  if (row === null) return undefined
  return {
    cacheKey: row.cacheKey,
    imageHash: row.imageHash,
    queryHash: row.queryHash,
    ocrText: row.ocrText,
    visualAnalysis: row.visualAnalysis,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    updatedAt: row.updatedAt,
  }
}

export async function saveImageAnalysisCache(entry: ImageAnalysisCacheEntry) {
  // Migrated to kind `imageCache.put` in wave 4 (W4-CODEMOD).
  // Upsert keyed by (workspace, cacheKey) with the same
  // conflict-update fields as upstream. `updatedAt` is
  // server-assigned and `expiresAt` defaults to the handler TTL
  // policy, so the caller-supplied `updatedAt` is not sent.
  await getSqlAdapter().execute({
    kind: 'imageCache.put',
    entry: {
      cacheKey: entry.cacheKey,
      imageHash: entry.imageHash,
      queryHash: entry.queryHash,
      ocrText: entry.ocrText,
      visualAnalysis: entry.visualAnalysis,
      mimeType: entry.mimeType,
      width: entry.width,
      height: entry.height,
    },
  })
}

// `initImageAnalysisCacheDb` was pure DDL, had zero callers
// outside this module, and was deleted in wave 4 (W4-CODEMOD).
// The table is server-owned (migrations).
