import { Clipboard } from '@capacitor/clipboard';

// Expose the Capacitor clipboard API to the administration web UI.
window.MeshwariClipboard = {
  writeText: async (text) => Clipboard.write({ string: String(text ?? '') })
};
