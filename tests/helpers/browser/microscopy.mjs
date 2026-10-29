import { LOCAL_ONLY_CONFIG, openUploadModal, routeConfig, routeManifest } from './app.mjs';
import { UPLOAD_ZONE, dropFiles } from './drag-drop.mjs';
import { waitForSlicePaint } from './canvas.mjs';

export async function openLocalUploadModal(page, configOverride = LOCAL_ONLY_CONFIG) {
  await routeManifest(page);
  await routeConfig(page, configOverride);
  await openUploadModal(page);
}

export async function dropOnUploadZone(page, files) {
  await dropFiles(page, UPLOAD_ZONE, files);
}

export async function openMicroscopyImage(page, files) {
  await openLocalUploadModal(page);
  await dropOnUploadZone(page, files);
  return waitForSlicePaint(page);
}

export async function selectChannelAndTime(page, channelIndex, timeIndex) {
  await page.locator('#microscopy-channel-select').selectOption(String(channelIndex));
  await page.locator('#microscopy-time-select').selectOption(String(timeIndex));
}

export async function applyManualCalibration(page, { x, y, z }) {
  await page.locator('#microscopy-calibration-x').fill(String(x));
  await page.locator('#microscopy-calibration-y').fill(String(y));
  await page.locator('#microscopy-calibration-z').fill(String(z));
  await page.locator('#microscopy-calibration-apply').click();
}
