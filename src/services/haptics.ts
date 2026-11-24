import { Capacitor, registerPlugin } from '@capacitor/core'
import { useSettings } from './settings.js'

export type HapticStyle = 'light' | 'medium' | 'longPress' | 'confirm'

const startupRecovery =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<{ triggerHaptic(options: { style: HapticStyle }): Promise<void> }>(
        'StartupRecovery'
      )
    : null

/** 按用户「触感反馈」开关触发 Android 原生轻震动，遵循系统触感策略。 */
export const triggerHaptic = (style: HapticStyle = 'light') => {
  if (!startupRecovery || !useSettings.getState().hapticsEnabled) {
    return
  }
  void startupRecovery.triggerHaptic({ style }).catch(() => {})
}
