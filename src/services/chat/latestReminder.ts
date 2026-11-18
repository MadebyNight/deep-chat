import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

/** 地区字段留空，日期与星期使用设备时区。 */
export const createLatestReminder = ({ locale }: { locale: Locale }, now = new Date()): string =>
  [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    '',
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
