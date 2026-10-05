'use strict';

// Project the broker's FIFO-with-skip scheduler in worker-budget-sized waves.
// Running workers reserve their current wave; queued files are already canonical.
// This is admission accounting, not a timer for the parent turn or OS cleanup.
function estimateWorkerWaves(runningFiles, queuedFiles, maxWorkers) {
  const pending = queuedFiles.slice();
  let active = runningFiles.slice();
  let waves = 0;
  while (active.length || pending.length) {
    const occupied = new Set(active.flat());
    while (active.length < maxWorkers) {
      const index = pending.findIndex(files => !files.some(file => occupied.has(file)));
      if (index === -1) break;
      const [files] = pending.splice(index, 1);
      active.push(files);
      for (const file of files) occupied.add(file);
    }
    if (!active.length) return Infinity;
    waves += 1;
    active = [];
  }
  return waves;
}

module.exports = { estimateWorkerWaves };
