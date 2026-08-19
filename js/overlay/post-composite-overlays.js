let drawMicroscopyAnalysis = null;

export function setMicroscopyAnalysisOverlay(render) {
  drawMicroscopyAnalysis = render instanceof Function ? render : null;
}

export function drawPostCompositeOverlays(ctx) {
  drawMicroscopyAnalysis?.(ctx);
}
