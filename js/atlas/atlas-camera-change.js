export function matricesChanged(current, last, epsilon = 1e-6) {
  let moved = false;
  for (let i = 0; i < current.length; i += 1) {
    if (Math.abs(current[i] - last[i]) > epsilon) moved = true;
    last[i] = current[i];
  }
  return moved;
}

export function cameraViewChanged(camera, lastWorld, lastProj) {
  const worldMoved = matricesChanged(camera.matrixWorld.elements, lastWorld);
  const projMoved = matricesChanged(camera.projectionMatrix.elements, lastProj);
  return worldMoved || projMoved;
}
