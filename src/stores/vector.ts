import { create } from 'zustand';
import { initVectorDb, processAllMarkdownFiles, processMarkdownFile, checkEmbeddingModelAvailable, initBM25Search } from '@/lib/rag';
import { checkRerankModelAvailable } from '@/lib/ai/embedding';
import { platform } from "@/lib/platform";
import { toast } from '@/hooks/use-toast';
import {
  clearVectorDb,
  getAllVectorDocuments,
  getVectorIndexStats,
  replaceAllVectorDocuments,
  type VectorDocumentSnapshot,
  type VectorIndexStats
} from '@/db/vector';
import useRagSettingsStore from '@/stores/ragSettings';

interface VectorState {
  isAutoVectorEnabled: boolean;    // 是否在文件保存后自动更新向量
  isProcessing: boolean;           // 是否正在处理向量
  lastProcessTime: number | null;  // 最后一次处理向量的时间
  hasRerankModel: boolean;         // 是否有可用的重排序模型
  hasEmbeddingModel: boolean;      // 是否有可用的嵌入模型
  indexStats: VectorIndexStats;

  // 统计数据
  documentCount: number;           // 文档数量

  // 初始化函数
  initVectorDb: () => Promise<void>;

  setAutoVectorEnabled: (enabled: boolean) => Promise<void>;

  // 处理向量
  processAllDocuments: () => Promise<void>;
  processDocument: (filename: string, content: string) => Promise<void>;
  checkEmbeddingModel: () => Promise<boolean>;
  checkRerankModel: () => Promise<boolean>;
  refreshIndexStats: () => Promise<void>;
}

const useVectorStore = create<VectorState>((set, get) => ({
  isAutoVectorEnabled: true,
  isProcessing: false,
  lastProcessTime: null,
  hasRerankModel: false,
  hasEmbeddingModel: false,
  indexStats: {
    documentCount: 0,
    chunkCount: 0,
    bm25DocumentCount: 0,
    bm25ChunkCount: 0,
    lastUpdatedAt: null
  },
  documentCount: 0,

  // 初始化向量数据库
  initVectorDb: async () => {
    try {
      await useRagSettingsStore.getState().initSettings();
      await initVectorDb();

      // 初始化 BM25 索引
      await initBM25Search();

      // 读取用户设置
      const store = await platform.store.load('store.json');
      const isAutoVectorEnabled = await store.get<boolean>('autoVectorEnabled') ?? true;
      const lastProcessTime = await store.get<number>('lastVectorProcessTime') || null;
      const structuredKnowledgeConsent = await store.get<boolean>('ragStructuredKnowledgeConsent') ?? false;

      set({
        isAutoVectorEnabled,
        lastProcessTime
      });

      // 检查嵌入模型可用性
      if (isAutoVectorEnabled) {
        const modelAvailable = await get().checkEmbeddingModel();
        if (!modelAvailable) {
          toast({
            title: 'Vector database',
            description: 'No embedding model is configured or the model is unavailable. Please configure an embedding model in AI settings.',
            variant: 'destructive',
          });
        }
        if (structuredKnowledgeConsent) {
          const { resumeKnowledgeIndexQueue } = await import('@/lib/knowledge-index');
          void resumeKnowledgeIndexQueue();
        }
      }

      // 检查重排序模型是否可用
      const semanticEnabled = await store.get<boolean>('wikiSemanticSearchEnabled') !== false;
      const hasRerankModel = semanticEnabled ? await get().checkRerankModel() : false;
      set({ hasRerankModel });
      await get().refreshIndexStats();
    } catch (error) {
      console.error('初始化向量数据库失败:', error);
    }
  },

  setAutoVectorEnabled: async (enabled: boolean) => {
    const store = await platform.store.load('store.json');
    await store.set('autoVectorEnabled', enabled);
    set({ isAutoVectorEnabled: enabled });
  },

  // 处理所有文档向量
  processAllDocuments: async () => {
    // 如果已经在处理中，直接返回
    if (get().isProcessing) return;

    let processingToast: ReturnType<typeof toast> | undefined;
    let previousDocuments: VectorDocumentSnapshot[] | null = null;

    try {
      // 检查嵌入模型是否可用
      const modelAvailable = await get().checkEmbeddingModel();
      if (!modelAvailable) {
        toast({
          title: 'Vector processing',
          description: 'No embedding model is configured or the model is unavailable. Please configure an embedding model in AI settings.',
          variant: 'destructive',
        });
        return;
      }

      // 设置处理状态
      set({ isProcessing: true });

      const forceRebuild = useRagSettingsStore.getState().indexNeedsRebuild;
      if (forceRebuild) {
        previousDocuments = await getAllVectorDocuments();
        await clearVectorDb();
      }

      // 显示处理开始的提示
      processingToast = toast({
        title: 'Vector processing',
        description: 'Started processing document vectors. This may take some time...',
        duration: Infinity,
      });

      // 处理所有文档，带进度回调
      const result = await processAllMarkdownFiles((current, total, fileName) => {
        processingToast?.update({
          title: 'Vector processing in progress',
          description: `Processed ${current}/${total}: ${fileName}`,
          duration: Infinity,
        });
      });
      const { processStructuredKnowledgeSources } = await import('@/lib/knowledge-index');
      const structuredResult = await processStructuredKnowledgeSources((current, total, title) => {
        processingToast?.update({
          title: 'Knowledge base processing in progress',
          description: `Processed structured content ${current}/${total}: ${title}`,
          duration: Infinity,
        });
      });

      const totalFailed = result.failed + structuredResult.failed;
      if ((totalFailed > 0 || result.paused || structuredResult.paused) && previousDocuments) {
        await replaceAllVectorDocuments(previousDocuments);
        await initBM25Search();
      }

      // 更新处理时间和状态
      const currentTime = Date.now();
      const store = await platform.store.load('store.json');
      await store.set('lastVectorProcessTime', currentTime);

      set({
        isProcessing: false,
        lastProcessTime: currentTime,
        documentCount: result.success + structuredResult.success
      });

      // 重新初始化 BM25 索引
      await initBM25Search();
      if (totalFailed === 0 && !result.paused && !structuredResult.paused) {
        await useRagSettingsStore.getState().markIndexClean();
      }
      await get().refreshIndexStats();

      // 显示处理结果
      let description = `Successfully processed ${result.success} documents`;
      description += `, ${structuredResult.success} records or canvases`;
      if (totalFailed > 0) {
        description += `, ${totalFailed} sources failed`;
        // 如果有失败文件，显示前几个
        if (result.failedFiles && result.failedFiles.length > 0) {
          const failedSample = result.failedFiles.slice(0, 3).map(f => f.fileName).join('、');
          description += `\nFailed files: ${failedSample}${result.failedFiles.length > 3 ? ' and more' : ''}`;
        }
      }

      processingToast.update({
        title: totalFailed > 0 || result.paused || structuredResult.paused ? 'Vector processing complete (partially incomplete)' : 'Vector processing complete',
        description,
        variant: totalFailed > 0 ? 'destructive' : 'default',
        duration: 5000,
      });
    } catch (error) {
      console.error('处理文档向量失败:', error);
      set({ isProcessing: false });

      if (previousDocuments) {
        try {
          await replaceAllVectorDocuments(previousDocuments);
          await initBM25Search();
          await get().refreshIndexStats();
        } catch (restoreError) {
          console.error('恢复原有知识库索引失败:', restoreError);
        }
      }

      const errorToast = {
        title: 'Vector processing failed',
        description: 'An error occurred while processing document vectors. Please check the console logs.',
        variant: 'destructive',
        duration: 5000,
      } as const;

      if (processingToast) {
        processingToast.update(errorToast);
      } else {
        toast(errorToast);
      }
    }
  },

  // 处理单个文档向量
  processDocument: async (filePath: string, content: string) => {
    try {
      await processMarkdownFile(filePath, content);
    } catch (error) {
      console.error(`处理文档 ${filePath} 向量失败:`, error);
    }
  },

  // 检查嵌入模型可用性
  checkEmbeddingModel: async () => {
    try {
      const modelAvailable = await checkEmbeddingModelAvailable();
      set({ hasEmbeddingModel: modelAvailable });
      return modelAvailable;
    } catch (error) {
      console.error('检查嵌入模型失败:', error);
      set({ hasEmbeddingModel: false });
      return false;
    }
  },

  // 检查重排序模型可用性
  checkRerankModel: async () => {
    try {
      const modelAvailable = await checkRerankModelAvailable();
      set({ hasRerankModel: modelAvailable });
      return modelAvailable;
    } catch (error) {
      console.error('检查重排序模型失败:', error);
      set({ hasRerankModel: false });
      return false;
    }
  },

  refreshIndexStats: async () => {
    try {
      const indexStats = await getVectorIndexStats();
      set({ indexStats, documentCount: indexStats.documentCount });
    } catch (error) {
      console.error('读取知识库索引统计失败:', error);
    }
  }
}));

export default useVectorStore;
