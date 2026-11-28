import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
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
  const themePackage = useSettings((state) => state.themePackage)
  const identity = themePackage?.identity
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <img className={styles.brandMark} src={whaleLogo} width={44} height={34} alt="" />
          <span>{identity?.welcomeTitle ?? t(greetingKey())}</span>
        </div>
        {identity?.welcomeSubtitle ? (
          <p className={styles.subtitle}>{identity.welcomeSubtitle}</p>
        ) : null}
        {themePackage?.welcomeCard ? (
          <div className={styles.templateCard}>
            {themePackage.welcomeCard.title ? (
              <strong>{themePackage.welcomeCard.title}</strong>
            ) : null}
            {themePackage.welcomeCard.body ? (
              <p>{themePackage.welcomeCard.body}</p>
            ) : null}
          </div>
        ) : null}
        <ChatInput sessionId={null} showPrompt placeholder={identity?.promptHint} />
      </div>
    </div>
  )
}
