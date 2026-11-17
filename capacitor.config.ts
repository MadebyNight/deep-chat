import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.deepchat.mobile',
  appName: 'Deep Chat',
  webDir: 'dist',
  android: { allowMixedContent: false, backgroundColor: '#0f0f0f' },
  server: { androidScheme: 'https' },
}
export default config
