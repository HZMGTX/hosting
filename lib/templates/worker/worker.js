// Background worker: does a unit of work every INTERVAL_SECONDS and shuts down cleanly on stop.
const intervalMs = (parseInt(process.env.INTERVAL_SECONDS, 10) || 60) * 1000;
let runs = 0;
let stopping = false;

async function doWork() {
  runs++;
  // Replace this with real work: poll an API, process a queue, clean up a database…
  console.log(`[worker] run #${runs} at ${new Date().toISOString()}`);
}

async function loop() {
  while (!stopping) {
    try {
      await doWork();
    } catch (err) {
      console.error('[worker] job failed:', err);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function shutdown(signal) {
  console.log(`[worker] received ${signal}, finishing up…`);
  stopping = true;
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`[worker] started, interval ${intervalMs / 1000}s`);
loop();
