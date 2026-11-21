import * as React from "react"
import { useEffect, useState } from "react"
import { AiConfig } from "../../setting/config"
import { toast } from "@/hooks/use-toast"
import { useUserErrorMessage } from "@/lib/use-user-error-message"
import { groupModelsByConfig, persistModelSelection, type GroupedModel } from "./model-select-helpers"
import { platform } from "@/lib/platform"
import useSettingStore from "@/stores/setting"
import { ChevronsUpDown, X } from "lucide-react"
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTrigger,
} from "@/components/responsive-popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { TooltipButton } from "@/components/tooltip-button"

export function ModelSelect({
  modelKey,
  emptyLabel,
  clearTooltip,
  onValueChange,
  value,
  persistSelection = true,
}: {
  modelKey: string
  emptyLabel?: string
  clearTooltip?: string
  onValueChange?: (model: string) => void | Promise<void>
  value?: string
  persistSelection?: boolean
}) {
  const [groupedModels, setGroupedModels] = useState<GroupedModel[]>([])
  const { setCompletionModel, setEditorModel, setMarkDescModel, setPrimaryModel, setImageMethodModel, setAudioModel, setSttModel, setEmbeddingModel, setRerankingModel } = useSettingStore()
  const [model, setModel] = useState<string>('')
  const [open, setOpen] = React.useState(false)
  const t = useTranslations('settings.defaultModel')
  const tAi = useTranslations('settings.ai')
  const userErrorMessage = useUserErrorMessage()

  useEffect(() => {
    if (value !== undefined) setModel(value)
  }, [value])

  // 获取正确的存储键名
  function getStoreKey(modelKey: string): string {
    switch (modelKey) {
      case 'primaryModel':
        return 'primaryModel'
      case 'imageMethod':
        return 'imageMethodModel'
      case 'completion':
        return 'completionModel'
      case 'markDesc':
        return 'markDescModel'
      case 'audio':
      case 'tts':
        return 'audioModel'
      case 'stt':
        return 'sttModel'
      case 'embedding':
        return 'embeddingModel'
      case 'reranking':
        return 'rerankingModel'
      default:
        return `${modelKey}Model`
    }
  }

  function setPrimaryModelHandler(primaryModel: string) {
    setModel(primaryModel)
    switch (modelKey) {
      case 'primaryModel':
        setPrimaryModel(primaryModel)
        break;
      case 'editor':
        setEditorModel(primaryModel)
        break;
      case 'imageMethod':
        setImageMethodModel(primaryModel)
        break;
      case 'completion':
        setCompletionModel(primaryModel)
        break;
      case 'markDesc':
        setMarkDescModel(primaryModel)
        break;
      case 'audio':
      case 'tts':
        setAudioModel(primaryModel)
        break;
      case 'stt':
        setSttModel(primaryModel)
        break;
      case 'embedding':
        setEmbeddingModel(primaryModel)
        break;
      case 'reranking':
        setRerankingModel(primaryModel)
        break;
      default:
        break;
    }
  }

  // 获取需要过滤的模型类型
  function getTargetModelType(modelKey: string): string {
    switch (modelKey) {
      case 'embedding':
        return 'embedding'
      case 'reranking':
        return 'rerank'
      case 'audio':
      case 'tts':
        return 'tts'
      case 'stt':
        return 'stt'
      default:
        return 'chat'
    }
  }

  async function initModelList() {
    const store = await platform.store.load('store.json');
    const aiConfigs = await store.get<AiConfig[]>('aiModelList')
    if (!aiConfigs) return
    const models: GroupedModel[] = []
    const targetModelType = getTargetModelType(modelKey)
    
    aiConfigs.forEach(config => {
      // 检查配置是否有效
      if (!config.baseURL) return
      
      // 处理新的 models 数组结构
      if (config.models && config.models.length > 0) {
        config.models.forEach(model => {
          // 根据modelKey过滤对应类型的模型
          if (model.modelType === targetModelType && model.model) {
            models.push({
              configKey: config.key,
              configTitle: config.title,
              model,
            })
          }
        })
      } else {
        // 向后兼容：处理旧的单模型结构
        const configModelType = config.modelType || 'chat'
        if (configModelType === targetModelType && config.model) {
          models.push({
            configKey: config.key,
            configTitle: config.title,
            model: {
              id: config.key,
              model: config.model,
              modelType: configModelType,
              temperature: config.temperature,
              topP: config.topP,
              voice: config.voice,
              enableStream: config.enableStream
            }
          })
        }
      }
    })

    setGroupedModels(models)
    if (value !== undefined) {
      setModel(value)
      return
    }
    
    const storeKey = getStoreKey(modelKey)
    const primaryModel = await store.get<string>(storeKey)
    if (!primaryModel) return
    setPrimaryModelHandler(primaryModel)
  }

  async function modelSelectChangeHandler(e: string) {
    if (!persistSelection) {
      await onValueChange?.(e)
      if (value === undefined) setModel(e)
      return
    }
    const previousModel = model
    setPrimaryModelHandler(e)
    try {
      const store = await platform.store.load('store.json');
      const storeKey = getStoreKey(modelKey)
      await persistModelSelection(store, storeKey, e)
    } catch (error) {
      // DA-3 (SET-01): a failed persist must not leave the UI
      // showing a selection that was never saved.
      setPrimaryModelHandler(previousModel)
      toast({
        description: userErrorMessage(error) ?? tAi('persistFailed'),
        variant: 'destructive',
      })
      return
    }
    await onValueChange?.(e)
  }

  async function resetDefaultModel() {
    if (!persistSelection) {
      await onValueChange?.('')
      if (value === undefined) setModel('')
      return
    }
    try {
      const store = await platform.store.load('store.json');
      const storeKey = getStoreKey(modelKey)
      await persistModelSelection(store, storeKey, '')
    } catch (error) {
      // The handler below runs only after a successful persist,
      // so the visible selection is still the previous one.
      toast({
        description: userErrorMessage(error) ?? tAi('persistFailed'),
        variant: 'destructive',
      })
      return
    }
    setPrimaryModelHandler('')
    await onValueChange?.('')
  }

  // 检查模型是否被选中（支持向后兼容）
  const isModelSelected = (item: GroupedModel): boolean => {
    if (!model) return false
    
    return model === item.model.id || model === `${item.configKey}-${item.model.id}`
  }

  // 查找当前选中的模型显示信息
  const findSelectedModelDisplay = () => {
    if (!model || !groupedModels.length) return null
    
    // 首先尝试精确匹配（新格式的组合键）
    const selectedItem = groupedModels.find(isModelSelected)
    
    if (selectedItem) {
      return `${selectedItem.model.model}(${selectedItem.configTitle})`
    }
    
    return null
  }

  // 按配置分组模型 (DA-3 SET-13: group by provider key, not
  // title, so same-title providers stay separate groups)
  const groupedByConfig = groupModelsByConfig(groupedModels)

  useEffect(() => {
    initModelList()
  }, [])
  
  return (
    <ResponsivePopover open={open} onOpenChange={setOpen} mobileTitle={t('tooltip')}>
      <div className="flex w-full min-w-0 gap-2 sm:w-auto">
        <ResponsivePopoverTrigger asChild>
          <div className="min-w-0 flex-1 overflow-hidden">
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-full min-w-0 justify-between sm:w-[280px]"
            >
              {model
                ? findSelectedModelDisplay() || t('modelUnavailable')
                : emptyLabel || (modelKey === 'primaryModel' ? t('noModel') : t('tooltip'))}
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </div>
        </ResponsivePopoverTrigger>
        <TooltipButton
          disabled={!model}
          icon={<X className="h-4 w-4" />}
          onClick={resetDefaultModel}
          variant="outline"
          tooltipText={clearTooltip || t('tooltip')}
        />
      </div>
      <ResponsivePopoverContent align="end" className="p-0">
        <Command>
          <CommandInput placeholder={t('placeholder')} className="h-9" />
          <CommandList>
            <CommandEmpty>{t('noModelFound')}</CommandEmpty>
            {groupedByConfig.map((group) => (
              <CommandGroup
                key={group.configKey}
                heading={group.configTitle}
              >
                {group.items.map((item) => (
                  <CommandItem
                    key={`${item.configKey}-${item.model.id}`}
                    value={item.model.id}
                    data-checked={isModelSelected(item)}
                    onSelect={(currentValue) => {
                      modelSelectChangeHandler(currentValue)
                      setOpen(false)
                    }}
                  >
                    {item.model.model}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  )
}
