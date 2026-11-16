import { platform } from "@/lib/platform";
import { v4 as uuid } from 'uuid';
import { toast } from "@/hooks/use-toast";

export interface PicgoImageHostingSetting {
  url: string
  port: string
}

export async function uploadImageByPicgo(image: File) {
  const store = await platform.store.load('store.json');
  const picgoSetting = await store.get<PicgoImageHostingSetting>('picgo')
  if (!picgoSetting) {
    return null
  }
  // 将 File 保存至缓存目录
  const cacheDir = await platform.path.appDataDir()
  const cachePath = `${cacheDir}/picgo`
  if (!await platform.fs.exists(cachePath)) {
    await platform.fs.mkdir(cachePath)
  }
  const cacheFile = `${cachePath}/${uuid()}.png`
  const uint8Array = new Uint8Array(await image.arrayBuffer())
  await platform.fs.writeFile(cacheFile, uint8Array)
  const body = {
    list: [cacheFile]
  }
  try {
    const response = await fetch(`${picgoSetting.url}/upload`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
    const data = await response.json()
    if (data.success) {
      return data.result[0]
    }
    return null
  } catch (error) {
    toast({
      title: 'Upload failed',
      description: error instanceof Error ? error.message : 'Upload failed',
      variant: 'destructive',
    })
    return null
  } finally {
    await platform.fs.remove(cacheFile)
  }
}

export async function checkPicgoState() {
  const store = await platform.store.load('store.json');
  const picgoSetting = await store.get<PicgoImageHostingSetting>('picgo')
  if (!picgoSetting) {
    return false
  }
  try {
    const response = await fetch(`${picgoSetting.url}/upload`, {
      method: 'POST',
    })
    await response.json()
    return true
  } catch {
    return false
  }
}
  