import { THREE_ADDONS_URL } from '../core/dependencies.js';

const mod = await import(`${THREE_ADDONS_URL}controls/TrackballControls.js`);

export const TrackballControls = mod.TrackballControls;
