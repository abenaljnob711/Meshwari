import { Preferences } from '@capacitor/preferences';

const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

window.MeshwariSession = {
  async getToken() {
    try {
      if (isNative()) {
        const result = await Preferences.get({ key: 'mw_token' });
        if (result.value) {
          localStorage.setItem('mw_token', result.value);
          return result.value;
        }
        const legacy = localStorage.getItem('mw_token') || '';
        if (legacy) await Preferences.set({ key: 'mw_token', value: legacy });
        return legacy;
      }
    } catch (error) {
      console.warn('Native session restore failed; using local storage fallback:', error);
    }
    return localStorage.getItem('mw_token') || '';
  },

  async setToken(value) {
    const token = String(value || '');
    localStorage.setItem('mw_token', token);
    if (isNative()) await Preferences.set({ key: 'mw_token', value: token });
  },

  async removeToken() {
    localStorage.removeItem('mw_token');
    if (isNative()) await Preferences.remove({ key: 'mw_token' });
  }
};
