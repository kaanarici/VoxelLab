import { THREE_ADDONS_URL } from '../core/dependencies.js';

// Desktop serves the local addon module directly; the CDN needs the `/+esm`
// suffix to get an ES-module build. THREE_ADDONS_URL is a CDN https URL only in
// the browser build (local desktop assets are served root-absolute).
const mod = await import(
  THREE_ADDONS_URL.startsWith('http')
    ? `${THREE_ADDONS_URL}controls/TrackballControls.js/+esm`
    : `${THREE_ADDONS_URL}controls/TrackballControls.js`
);

export const TrackballControls = mod.TrackballControls;
