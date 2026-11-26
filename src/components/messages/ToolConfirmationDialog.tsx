import { Button, Modal } from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import { answerToolConfirmation, useToolConfirmation } from '../../services/tools/confirmation.js'
import { formatToolInput } from '../../services/tools/runtime.js'
import styles from './ToolConfirmation.module.css'

export const ToolConfirmationDialog = () => {
  const t = useTranslate()
  const request = useToolConfirmation((state) => state.requests[0] ?? null)
  if (!request) {
    return null
  }
  const label = request.serverName ? `${request.serverName} · ${request.name}` : request.name
  const answer = (allow: boolean) =>
    answerToolConfirmation(request.replyId, request.toolUseId, allow)
  return (
    <Modal
      title={t('mcpToolConfirmTitle')}
      layout="confirm"
      onClose={() => answer(false)}
      footer={
        <>
          <Button variant="outlined" onClick={() => answer(false)}>
            {t('mcpToolDeny')}
          </Button>
          <Button onClick={() => answer(true)}>{t('mcpToolAllow')}</Button>
        </>
      }
    >
      <div className={styles.body}>
        <strong>{label}</strong>
        <code className={styles.arguments}>{formatToolInput(request.input)}</code>
      </div>
    </Modal>
  )
}
