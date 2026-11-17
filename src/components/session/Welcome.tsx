import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import whaleLogo from '../../assets/whale.png'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 官方欢迎语随时段变化；无法归类的时段用中性问候 */
const greetingKey = (): TranslationKey => {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) {
    return 'welcomeMorning'
  }
  if (hour >= 12 && hour < 18) {
    return 'welcomeAfternoon'
  }
  if (hour >= 18 && hour < 24) {
    return 'welcomeEvening'
  }
  return 'welcomeNight'
}

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <img className="welcome-mark" src={whaleLogo} alt="" width={44} height={34} />
          <span>{t(greetingKey())}</span>
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>Deep Chat · DeepSeek 第三方客户端</div> : null}
      </div>
    </div>
  )
}
