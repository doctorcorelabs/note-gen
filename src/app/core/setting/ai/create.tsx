import { useState } from "react"
import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"
import { v4 } from "uuid"

import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"
import { useUserErrorMessage } from "@/lib/use-user-error-message"
import useSettingStore from "@/stores/setting"
import type { AiConfig } from "../config"

interface CreateConfigProps {
  onConfigCreated?: (configId: string) => void
}

export default function CreateConfig({ onConfigCreated }: CreateConfigProps) {
  const t = useTranslations('settings.ai')
  const userErrorMessage = useUserErrorMessage()
  const { setAiModelList } = useSettingStore()
  const [creating, setCreating] = useState(false)

  const addCustomProvider = async () => {
    if (creating) return

    setCreating(true)
    try {
      const aiModelList = useSettingStore.getState().aiModelList
      const id = v4()
      const newProvider: AiConfig = {
        key: id,
        title: t('custom'),
        baseURL: '',
        templateSource: 'custom',
        modelType: 'chat',
        temperature: 0.7,
        topP: 1.0,
      }
      const updatedList = [newProvider, ...aiModelList]

      setAiModelList(updatedList)
      const settingStore = await import('@/stores/setting')
      await settingStore.flushChangedSyncableSettingsPersist()
      onConfigCreated?.(id)
    } catch (error) {
      toast({
        description: userErrorMessage(error) ?? t('saveFailed'),
        variant: 'destructive',
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Button disabled={creating} onClick={addCustomProvider}>
      <Plus data-icon="inline-start" />{t('create')}
    </Button>
  )
}
