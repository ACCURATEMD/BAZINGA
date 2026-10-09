#!/usr/bin/env node
// Merge a job list (changes.json format: an array of clients, each with jobs)
// into BAZINGA's Firestore database, without replacing what is already there.
//
//   node import-list.js <list.json>                    dry run: shows what would change
//   node import-list.js <list.json> --apply            write the changes
//   node import-list.js <list.json> --apply --status   also copy open/closed status from the list
//   node import-list.js --from-appstate [--source appState/<doc>.<field>] [--apply] [--status]
//                                                       use the live site's own saved data
//                                                       (Firestore collection appState) as the list
//
// What it does:
//   - clients not in the database are added (matched by name)
//   - jobs not in the database are added (matched by position + date added)
//   - candidates on matching jobs that are missing are added (matched by name)
//   - client fields that are empty in the database (account manager, documents,
//     dispatch defaults, ...) are filled in; nothing already there is overwritten
//   - with --status, a job's closed/open state (and close reason / date) is
//     taken from the list when the two differ
// NOTE: this tool writes into the bazingaClients collection, which is the older
// layout. The board itself now lives in appState/main, so when that document
// holds the list, --apply refuses rather than writing to a store nothing reads.
// A dry run still works and is useful for comparing the two.
//
// --from-appstate only READS the appState collection (it never writes there), so
// the live site can keep running while you copy. It looks through every document
// in appState for a list of clients (each with a name and a jobs list), whether
// stored as a real list or as JSON text, and uses it as <list.json>. If it finds
// more than one, it shows them and you pick one with --source.
// Nothing is ever deleted. Before --apply writes, the existing versions of every
// client it touches are saved to bazinga-backup-<time>.json next to this file.
//
// Stop BAZINGA (the PC copy and the Cloud Run service) before --apply, then start
// or redeploy it afterwards: a running server keeps its own copy in memory and
// would write that copy back over the import.
//
// Needs the same Google sign-in as server.js: gcloud auth application-default login
// (or FIRESTORE_EMULATOR_HOST for testing).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');

const args = process.argv.slice(2);
const srcIdx = args.indexOf('--source');
const SOURCE = srcIdx >= 0 ? args[srcIdx + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && i !== srcIdx + 1);
const APPLY = args.includes('--apply');
const STATUS = args.includes('--status');
const FROM_APPSTATE = args.includes('--from-appstate');
if (!file && !FROM_APPSTATE) {
    console.error('Usage: node import-list.js <list.json> [--apply] [--status]');
    console.error('   or: node import-list.js --from-appstate [--source appState/<doc>.<field>] [--apply] [--status]');
    process.exit(1);
}

const APP_STATE = 'main';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const jobKey = (j) => norm(j.position) + '|' + String(j.dateAdded || '').slice(0, 16);
const newId = () => crypto.randomUUID();
const isEmpty = (v) => v === undefined || v === null;

// Keys within one client: the same position added in the same minute twice
// gets a #2 so the copies stay distinct.
function keyed(jobs) {
    const seen = new Map();
    return (jobs || []).map((job) => {
        const base = jobKey(job);
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return { key: n === 1 ? base : `${base}#${n}`, job };
    });
}

const isClientList = (v) =>
    Array.isArray(v) && v.length > 0 &&
    v.every((c) => c && typeof c === 'object' && typeof c.name === 'string' && Array.isArray(c.jobs));

// Finds every client list inside the documents of the appState collection.
async function findAppStateLists(db) {
    const snap = await db.collection('appState').get();
    const found = [];
    const summary = [];
    const walk = (v, where) => {
        if (typeof v === 'string' && /^\s*\[/.test(v)) {
            try { v = JSON.parse(v); } catch (e) { return; }
        }
        if (isClientList(v)) { found.push({ where, list: v }); return; }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
        }
    };
    for (const d of snap.docs) {
        const data = d.data();
        summary.push(`  appState/${d.id}: ` + Object.entries(data).map(([k, v]) =>
            `${k} (${Array.isArray(v) ? `list of ${v.length}` : typeof v})`).join(', '));
        walk(data, `appState/${d.id}`);
    }
    return { found, summary, docs: snap.size };
}

async function main() {
    const db = new Firestore({
        projectId: process.env.FIRESTORE_PROJECT || 'bazingaopens',
        ignoreUndefinedProperties: true,
    });

    let list;
    if (FROM_APPSTATE) {
        const { found, summary, docs } = await findAppStateLists(db);
        console.log(`\nappState collection: ${docs} document(s).`);
        summary.forEach((x) => console.log(x));
        if (!found.length) throw new Error('No list of clients (each with a name and jobs) was found in appState.');
        console.log('\nClient lists found:');
        found.forEach((f) => {
            const open = f.list.reduce((n, c) => n + (c.jobs || []).filter((j) => j && !j.closed).length, 0);
            console.log(`  ${f.where}: ${f.list.length} clients, ${open} open jobs`);
        });
        let pick = found[0];
        if (SOURCE) {
            pick = found.find((f) => f.where === SOURCE);
            if (!pick) throw new Error(`--source ${SOURCE} is not one of the lists above.`);
        } else if (found.length > 1) {
            throw new Error('More than one list was found. Run again with --source <one of the paths above>.');
        }
        console.log(`Using ${pick.where}.`);
        list = pick.list;
    } else {
        list = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(list)) throw new Error('The file must be a list of clients (the changes.json format).');
    }
    const col = db.collection('bazingaClients');
    const snap = await col.orderBy('order').get();
    const existing = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const byName = new Map();
    for (const e of existing) if (!byName.has(norm(e.data.name))) byName.set(norm(e.data.name), e);
    let nextOrder = existing.reduce((m, e) => Math.max(m, Number.isFinite(e.data.order) ? e.data.order : -1), -1) + 1;

    const out = { addedClients: [], addedJobs: [], statusChanges: [], addedCandidates: 0, filledFields: 0 };
    const writes = new Map();   // doc id -> new doc data
    const backups = new Map();  // doc id -> existing doc data (only for touched, existing clients)

    for (const src of list) {
        if (!src || typeof src !== 'object' || !src.name) continue;
        const have = byName.get(norm(src.name));

        if (!have) {
            const doc = JSON.parse(JSON.stringify(src));
            doc.id = doc.id || newId();
            for (const j of doc.jobs || []) if (!j.id) j.id = newId();
            doc.jobs = doc.jobs || [];
            doc.order = nextOrder++;
            writes.set(doc.id, doc);
            // Kept in byName so the same client listed twice merges into this doc
            // rather than being skipped or overwriting it.
            byName.set(norm(doc.name), { id: doc.id, data: doc });
            out.addedClients.push(`${src.name.trim()} (${doc.jobs.length} job${doc.jobs.length === 1 ? '' : 's'})`);
            continue;
        }

        // Build on the version already queued for this client, if any, so two
        // entries with the same name both land instead of the second replacing
        // the first.
        const doc = JSON.parse(JSON.stringify(writes.get(have.id) || have.data));
        let touched = false;
        doc.jobs = Array.isArray(doc.jobs) ? doc.jobs : [];

        for (const [k, v] of Object.entries(src)) {
            if (k === 'jobs' || k === 'id' || k === 'order') continue;
            if (isEmpty(doc[k]) && !isEmpty(v)) { doc[k] = v; out.filledFields++; touched = true; }
        }

        const have_jobs = new Map(keyed(doc.jobs).map((x) => [x.key, x.job]));
        for (const { key, job } of keyed(src.jobs)) {
            const mine = have_jobs.get(key);
            if (!mine) {
                const added = JSON.parse(JSON.stringify(job));
                added.id = added.id || newId();
                doc.jobs.push(added);
                have_jobs.set(key, added);
                out.addedJobs.push(`${src.name.trim()} | ${String(job.position || '').trim()} | ${job.shift || ''} | ${job.closed ? 'closed' : 'OPEN'}`);
                touched = true;
                continue;
            }
            if (STATUS && !!mine.closed !== !!job.closed) {
                out.statusChanges.push(`${src.name.trim()} | ${String(job.position || '').trim()}: ${mine.closed ? 'closed' : 'open'} -> ${job.closed ? 'closed' : 'open'}`);
                mine.closed = !!job.closed;
                if (job.closed) { mine.closeReason = job.closeReason ?? null; mine.dateClosed = job.dateClosed ?? null; }
                else { mine.closeReason = null; mine.dateClosed = null; }
                touched = true;
            }
            const names = new Set((mine.candidates || []).map((c) => norm(c && c.name)));
            for (const c of job.candidates || []) {
                if (!c || !c.name || names.has(norm(c.name))) continue;
                (mine.candidates = mine.candidates || []).push(c);
                names.add(norm(c.name));
                out.addedCandidates++;
                touched = true;
            }
        }
        if (touched || writes.has(have.id)) {
            writes.set(have.id, doc);
            have.data = doc;
            if (existing.some((e) => e.id === have.id)) backups.set(have.id, existing.find((e) => e.id === have.id).data);
        }
    }

    console.log(`\nList: ${list.length} clients.  Database: ${existing.length} clients.`);
    console.log(`\nClients to add (${out.addedClients.length}):`);
    out.addedClients.forEach((x) => console.log('  + ' + x));
    console.log(`\nJobs to add (${out.addedJobs.length}):`);
    out.addedJobs.forEach((x) => console.log('  + ' + x));
    if (STATUS) {
        console.log(`\nOpen/closed changes (${out.statusChanges.length}):`);
        out.statusChanges.forEach((x) => console.log('  ~ ' + x));
    } else {
        console.log('\nOpen/closed status is left as it is in the database (add --status to copy it from the list).');
    }
    console.log(`\nCandidates to add to existing jobs: ${out.addedCandidates}.  Empty client fields to fill: ${out.filledFields}.`);
    console.log(`Documents to write: ${writes.size} (${backups.size} existing clients changed, ${out.addedClients.length} new).`);

    if (APPLY) {
        const live = await db.collection('appState').doc(APP_STATE).get();
        const liveClients = live.exists && Array.isArray(live.data().clients) ? live.data().clients : [];
        if (liveClients.length) {
            console.log(`\nNot writing: the board itself lives in appState/${APP_STATE} (${liveClients.length} clients), and this tool writes to the older bazingaClients collection, which nothing reads any more.`);
            console.log('Make the change in BAZINGA itself, or ask for a version of this tool that merges into appState.');
            return;
        }
    }

    if (!APPLY) {
        console.log('\nDry run: nothing was written. Stop BAZINGA, then run again with --apply to make these changes.');
        return;
    }
    if (!writes.size) { console.log('\nNothing to change.'); return; }

    if (backups.size) {
        const bf = path.join(__dirname, `bazinga-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(bf, JSON.stringify([...backups].map(([id, data]) => ({ id, ...data })), null, 2));
        console.log(`\nBacked up ${backups.size} existing client(s) to ${path.basename(bf)}.`);
    }
    const entries = [...writes];
    for (let i = 0; i < entries.length; i += 400) {
        const batch = db.batch();
        for (const [id, data] of entries.slice(i, i + 400)) batch.set(col.doc(id), data);
        await batch.commit();
    }
    console.log(`Done: wrote ${entries.length} document(s). Now start or redeploy BAZINGA so it loads them.`);
}

main().catch((err) => {
    console.error('Import failed:', err.message);
    if (/credential|authentic|UNAUTHENTICATED|Could not load the default/i.test(err.message)) {
        console.error('Run "gcloud auth application-default login" once, then try again.');
    }
    process.exit(1);
});
