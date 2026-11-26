import { registerPlugin } from '@capacitor/core';

const DriverLocation = registerPlugin('DriverLocation');
window.MeshwariDriverLocation = {
  start: options => DriverLocation.start(options),
  stop: () => DriverLocation.stop()
};
