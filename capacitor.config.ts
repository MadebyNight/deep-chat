import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.deepchat.mobile',
  appName: 'Deep Chat',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0f0f0f',
    minWebViewVersion: 105,
    // Native plugin calls can carry recordings and private chat content.
    loggingBehavior: 'none',
    resolveServiceWorkerRequests: false,
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
  server: { androidScheme: 'https', errorPath: 'webview-error.html' },
}
// eslint-disable-next-line import/no-default-export
export default config
