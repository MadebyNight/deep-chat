import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCheckOutline16, IconCopyOutline16, IconButton } from "../base/index.js"

import { showToast } from '../base/toastState.js'
import { triggerHaptic } from '../../services/haptics.js'
import { copyText } from '../../utils/clipboard.js'

/** 复制成功后图标换成对勾 1 秒，期间再次点击不重复复制 */
export const CopyButton = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <IconButton
      icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      tooltip={t('copy')}
      tooltipPlacement="bottom"
      onClick={async () => {
        if (copied) {
          return
        }
        if (!(await copyText(text))) {
          showToast({ key: 'copyFailed' })
          return
        }
        triggerHaptic('light')
        setCopied(true)
        timerRef.current = setTimeout(() => setCopied(false), 1000)
      }}
    />
  )
}
