export const VIEWER_PERF_BUDGET = {
  baselineMs: {
    selectSeries2dMs: 38.9,
    scrub2dAvgMs: 14.5,
    compareScrubAvgMs: 16.4,
    enter3dMs: 156.1,
    enterMprMs: 80.5,
    mprScrubAvgMs: 14.0,
  },
  maxMs: {
    selectSeries2dMs: 500,
    scrub2dAvgMs: 250,
    overlayScrubAvgMs: 350,
    compareScrubAvgMs: 250,
    enter3dMs: 1_500,
    enterMprMs: 1_500,
    mprScrubAvgMs: 250,
  },
};
