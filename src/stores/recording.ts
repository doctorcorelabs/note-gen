import { create } from 'zustand'

interface RecordingState {
  // 录音状态
  isRecording: boolean
  isPaused: boolean
  recordingDuration: number // 录音时长（秒）

  // 录音数据
  audioChunks: Blob[]
  mediaRecorder: MediaRecorder | null

  // 计时器
  timerId?: NodeJS.Timeout

  // 控制方法
  startRecording: () => Promise<void>
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => Promise<Blob | null>
  cancelRecording: () => void
  
  // 内部方法
  setRecordingDuration: (duration: number) => void
  resetState: () => void
}

const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  isPaused: false,
  recordingDuration: 0,
  audioChunks: [],
  mediaRecorder: null,

  setRecordingDuration: (duration) => set({ recordingDuration: duration }),

  startRecording: async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('The current environment does not support microphone recording; check the Android WebView or app permission configuration')
      }

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      
      // 优先尝试更兼容的格式
      let mimeType = 'audio/webm'
      const supportedTypes = [
        'audio/wav',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus',
        'audio/webm'
      ]
      
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type
          break
        }
      }
      
      // 创建MediaRecorder实例
      const mediaRecorder = new MediaRecorder(stream, { mimeType })
      
      const chunks: Blob[] = []
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }
      
      mediaRecorder.start()
      
      // 启动计时器，保存到 state
      const timerId = setInterval(() => {
        const state = get()
        if (state.isRecording && !state.isPaused) {
          set({ recordingDuration: state.recordingDuration + 1 })
        } else {
          // 暂停时清除计时器
          clearInterval(state.timerId)
          set({ timerId: undefined })
        }
      }, 1000)

      set({
        isRecording: true,
        isPaused: false,
        audioChunks: chunks,
        mediaRecorder,
        recordingDuration: 0,
        timerId
      })
      
    } catch (error) {
      console.error('启动录音失败:', error)
      
      // 根据错误类型提供更具体的错误信息
      if (error instanceof DOMException) {
        if (error.name === 'NotAllowedError') {
          throw new Error('Microphone permission was denied; allow NoteGen to access the microphone in system settings')
        } else if (error.name === 'NotFoundError') {
          throw new Error('No microphone device detected; connect a microphone and retry')
        } else if (error.name === 'NotReadableError') {
          throw new Error('The microphone is in use by another app; close the other app and retry')
        }
      }
      
      throw new Error('Unable to start recording; check the microphone device and permission settings')
    }
  },

  pauseRecording: () => {
    const { mediaRecorder, timerId } = get()
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause()
      // 暂停时清除计时器
      if (timerId) {
        clearInterval(timerId)
      }
      set({ isPaused: true, timerId: undefined })
    }
  },

  resumeRecording: () => {
    const { mediaRecorder } = get()
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume()
      set({ isPaused: false })
    }
  },

  stopRecording: async (): Promise<Blob | null> => {
    const { mediaRecorder, audioChunks, timerId } = get()

    // 停止时清除计时器
    if (timerId) {
      clearInterval(timerId)
    }

    if (!mediaRecorder) {
      return null
    }
    
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || audioChunks[0]?.type || 'audio/webm' })
        mediaRecorder.stream.getTracks().forEach(track => track.stop())
        get().resetState()
        resolve(audioBlob)
      }
      
      mediaRecorder.stop()
    })
  },

  cancelRecording: () => {
    const { mediaRecorder } = get()
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    
    get().resetState()
  },

  resetState: () => {
    const { timerId } = get()
    // 重置时清除计时器
    if (timerId) {
      clearInterval(timerId)
    }
    set({
      isRecording: false,
      isPaused: false,
      recordingDuration: 0,
      audioChunks: [],
      mediaRecorder: null,
      timerId: undefined
    })
  }
}))

export default useRecordingStore
