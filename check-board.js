// Read-only: prints the board's open-job counts from appState/main, which jobs are
// full from Hired candidates, and anything closed since 8pm Oct 8. Writes nothing.
// Run: node check-board.js
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: 'bazingaopens' });
db.collection('appState').doc('main').get().then((d) => {
  const x = d.data() || {};
  const clients = x.clients || [];
  let raw = 0, ui = 0, positions = 0, hiredFull = [];
  const recent = [];
  for (const c of clients) for (const j of c.jobs || []) {
    if (j.closed) {
      if (j.dateClosed && j.dateClosed > '2026-10-08T20') recent.push(`${c.name} | ${j.position} | ${j.dateClosed} | ${j.closeReason || ''}`);
      continue;
    }
    raw++;
    const hired = (Array.isArray(j.candidates) ? j.candidates : []).filter((p) => p && typeof p === 'object' && p.status && p.status.toLowerCase() === 'hired').length;
    const spots = Math.max((j.needed || 1) - hired, 0);
    if (spots > 0) { ui++; positions += spots; } else hiredFull.push(`${c.name} | ${j.position} | needed ${j.needed} | hired ${hired}`);
  }
  console.log(`clients ${clients.length} | not closed ${raw} | board shows ${ui} open, ${positions} positions | closed-jobs log ${(x.closedJobs || []).length}`);
  console.log(`\nFull from hires (counted closed by the board): ${hiredFull.length}`);
  hiredFull.slice(0, 20).forEach((l) => console.log('  ' + l));
  console.log(`\nClosed since 8pm Oct 8: ${recent.length}`);
  recent.slice(0, 20).forEach((l) => console.log('  ' + l));
});
