import { voxelToPatientLps } from './geometry.js';

export function voxelToMM(series, vx, vy, vz) {
  if (!series.firstIPP || !series.orientation) return null;
  return voxelToPatientLps(series, vx, vy, vz);
}

export function formatLPS(mm) {
  if (!mm) return '';
  const [x, y, z] = mm;
  const lr = x < 0 ? 'R' : 'L';
  const ap = y < 0 ? 'A' : 'P';
  const si = z < 0 ? 'I' : 'S';
  return `${Math.abs(x).toFixed(1)}${lr} ${Math.abs(y).toFixed(1)}${ap} ${Math.abs(z).toFixed(1)}${si}`;
}
