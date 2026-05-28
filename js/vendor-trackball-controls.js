import { THREE_ADDONS_URL } from './dependencies.js';

const mod = await import(
  THREE_ADDONS_URL.startsWith('../')
    ? `${THREE_ADDONS_URL}controls/TrackballControls.js`
    : `${THREE_ADDONS_URL}controls/TrackballControls.js/+esm`
);

export const TrackballControls = mod.TrackballControls;
