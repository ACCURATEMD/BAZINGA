const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // Ensure you've installed this: npm install cors
const multer = require('multer');
const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow connections from any origin
    methods: ["GET", "POST"]
  }
});

// Enable CORS for all Express routes
app.use(cors());

const PORT = process.env.PORT || 3000;
const filePath = path.join(__dirname, 'changes.json'); // Path to the client data file
const closedJobsFilePath = path.join(__dirname, 'closed_jobs.json'); // Path to the closed jobs data file

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists inside public so uploaded files are served
const uploadsDir = path.join(__dirname, 'public', 'uploads');
try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        console.log('Created uploads directory at', uploadsDir);
    }
} catch (err) {
    console.error('Failed to create uploads directory:', err);
}

// Multer setup for handling document uploads (doc, docx, pdf)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safe);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter: function (req, file, cb) {
        const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, DOC, and DOCX are allowed.'));
        }
    }
});

// Upload endpoint for client documents
app.post('/upload', upload.single('document'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }
    // Return a URL that can be used by the client to access the uploaded file
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, file: { filename: req.file.filename, originalname: req.file.originalname, url: fileUrl } });
});

let currentData = []; // Store the current client data in memory
let closedJobsData = []; // Store closed jobs data in memory
let bgRequirementOptions = []; // Custom background-requirement choices
let recommendedByJob = {}; // jobId -> [recommended candidates], written by the lobby app

// --- Firestore storage ---
//
// Clients (with their jobs) live in Firestore so the data is shared by every
// copy of BAZINGA and readable by the lobby app, which matches applicants to
// open jobs and writes them back as "Recommended":
//
//   appState/main               the whole board in one document:
//                               { clients: [...], closedJobs: [...],
//                                 bgRequirementOptions: [...] }
//   bazingaRecommended/{jobId}  written by the lobby app; read-only here
//
// appState/main is the same document the live board has always used, so this
// version and the live one read and write the same list and cannot drift apart.
// On first start it takes over an older bazingaClients collection if that is
// all there is, and failing that seeds from changes.json.
//
// changes.json / closed_jobs.json are still written as a local backup.
// Credentials: on Cloud Run the service account is used automatically; on a
// PC run `gcloud auth application-default login` once (see README).
const db = new Firestore({
    projectId: process.env.FIRESTORE_PROJECT || 'bazingaopens',
    ignoreUndefinedProperties: true,
});
const stateDoc = db.collection('appState').doc('main');
const legacyClientsCol = db.collection('bazingaClients');  // only read, on first start
const recommendedCol = db.collection('bazingaRecommended');

const newId = () => crypto.randomUUID();

// Every client and job gets a stable id. Indices shift as clients and jobs are
// added or removed; the id is what the lobby app uses to find a job again.
function ensureIds(clients) {
    for (const c of clients || []) {
        if (!c || typeof c !== 'object') continue;
        if (!c.id) c.id = newId();
        for (const j of Array.isArray(c.jobs) ? c.jobs : []) {
            if (j && typeof j === 'object' && !j.id) j.id = newId();
        }
    }
    return clients;
}

// The board is one document, so a write goes out only when its content changed.
let lastWritten = null; // the JSON last written to appState/main
let persistTimer = null;
let persistChain = Promise.resolve();

function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistChain = persistChain.then(persistState).catch((err) => {
            console.error('Error saving clients to Firestore:', err);
            io.emit('server_error', { message: 'Saving to the database failed. Your last change may not be saved.' });
        });
    }, 250);
}

// A Firestore document holds 1 MiB; warn well before that.
const DOC_WARN_BYTES = 800 * 1024;

async function persistState() {
    const state = {
        clients: currentData,
        closedJobs: closedJobsData,
        bgRequirementOptions,
    };
    const json = JSON.stringify(state);
    if (json === lastWritten) return;
    if (Buffer.byteLength(json) > DOC_WARN_BYTES) {
        console.warn(`The board is ${Math.round(Buffer.byteLength(json) / 1024)} KB; a Firestore document holds 1024 KB. Close out old jobs or clear the closed-jobs log.`);
    }
    await stateDoc.set(state);
    lastWritten = json;
    console.log(`Saved the board to Firestore (${currentData.length} clients, ${closedJobsData.length} closed jobs).`);
}

function writeBackup(file, data) {
    fs.writeFile(file, JSON.stringify(data, null, 2), (err) => {
        if (err) console.error('Error writing local backup', path.basename(file), err.message);
    });
}

function broadcastState() {
    io.emit('change', { clients: currentData, closedJobs: closedJobsData, bgRequirementOptions, recommended: recommendedByJob });
}

// --- Helper Functions for Saving and Broadcasting ---

// Saves the current client data and broadcasts the full state
function saveChanges(data) {
    currentData = ensureIds(data); // Update server's in-memory state immediately
    schedulePersist();
    writeBackup(filePath, currentData);
    broadcastState();
}

// Saves the closed jobs data and broadcasts the full state
function saveClosedJobsChanges(data) {
    closedJobsData = data; // Update server's in-memory state
    schedulePersist();
    writeBackup(closedJobsFilePath, closedJobsData);
    broadcastState();
}

function saveSettings() {
    schedulePersist();
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send the current state (clients and closed jobs) to the newly connected client
    socket.emit('initial_state', { clients: currentData, closedJobs: closedJobsData, bgRequirementOptions, recommended: recommendedByJob });

    // --- Handle specific client actions ---

    socket.on('add_client', (newClient) => {
        console.log(`[${socket.id}] Received add_client:`, newClient.name);
        if (!Array.isArray(currentData)) { currentData = []; }
        const clientToAdd = {
            ...newClient,
            jobs: newClient.jobs || []
        };
        currentData.push(clientToAdd);
        saveChanges(currentData);
    });

    // Handle editing an existing client
    socket.on('edit_client', (payload) => {
        const { clientIndex, updatedClientData } = payload;
        console.log(`[${socket.id}] Received edit_client for index ${clientIndex}:`, updatedClientData.name);
         if (currentData && currentData[clientIndex]) {
             // Preserve the original jobs array unless it's explicitly part of updatedClientData
             const originalJobs = currentData[clientIndex].jobs;
             currentData[clientIndex] = {
                 ...currentData[clientIndex], // Keep original properties like jobs
                 ...updatedClientData,        // Overwrite with new data
                 id: currentData[clientIndex].id,
                 jobs: updatedClientData.jobs || originalJobs // Ensure jobs aren't lost if not sent
             };
            saveChanges(currentData);
        } else {
            console.error(`[${socket.id}] Invalid clientIndex (${clientIndex}) for edit_client.`);
        }
    });

     // Handle deleting a client
    socket.on('delete_client', (clientIndex) => {
         console.log(`[${socket.id}] Received delete_client for index ${clientIndex}`);
         if (currentData && currentData[clientIndex]) {
            const deletedClientName = currentData[clientIndex].name;
            currentData.splice(clientIndex, 1); // Remove the client from the array
            console.log(`   Deleted client: ${deletedClientName}`);
            saveChanges(currentData);
        } else {
            console.error(`[${socket.id}] Invalid clientIndex (${clientIndex}) for delete_client.`);
        }
    });


    socket.on('add_job', (payload) => {
        const { clientIndex, job } = payload;
        console.log(`[${socket.id}] Received add_job for client index ${clientIndex}:`, job.position);
         if (currentData && currentData[clientIndex]) {
             if (!Array.isArray(currentData[clientIndex].jobs)) {
                 currentData[clientIndex].jobs = [];
             }
             const jobToAdd = {
                 ...job,
                 id: newId(),
                 dateAdded: job.dateAdded || new Date().toISOString(),
                 closed: false
             };
             currentData[clientIndex].jobs.push(jobToAdd);
             saveChanges(currentData);
         } else {
             console.error(`[${socket.id}] Invalid clientIndex (${clientIndex}) for add_job.`);
         }
    });

    socket.on('edit_job', (payload) => {
        const { clientIndex, jobIndex, updatedJob } = payload;
         console.log(`[${socket.id}] Received edit_job for client index ${clientIndex}, job index ${jobIndex}:`, updatedJob.position);
        if (currentData && currentData[clientIndex] && currentData[clientIndex].jobs && currentData[clientIndex].jobs[jobIndex]) {
            const originalJob = currentData[clientIndex].jobs[jobIndex];
            currentData[clientIndex].jobs[jobIndex] = {
                ...originalJob,
                ...updatedJob,
                id: originalJob.id, // keep the job's identity (the lobby app keys Recommended by it)
                // Allow closed to be updated if provided, otherwise preserve original
                closed: (typeof updatedJob.closed !== 'undefined') ? updatedJob.closed : originalJob.closed
            };
            saveChanges(currentData);
        } else {
            console.error(`[${socket.id}] Invalid indices (client: ${clientIndex}, job: ${jobIndex}) for edit_job.`);
        }
    });

    socket.on('close_job', (payload) => {
        const { clientIndex, jobIndex, closeDetails } = payload;
        console.log(`[${socket.id}] Received close_job for client index ${clientIndex}, job index ${jobIndex}`);
        if (currentData && currentData[clientIndex] && currentData[clientIndex].jobs && currentData[clientIndex].jobs[jobIndex]) {
            const clientName = currentData[clientIndex].name;
            const jobToClose = currentData[clientIndex].jobs[jobIndex];
            // Calculate open spots (needed - hired)
            let hiredCount = 0;
            if (Array.isArray(jobToClose.candidates)) {
                hiredCount = jobToClose.candidates.filter(c =>
                    typeof c === "object" && c.status && c.status.toLowerCase() === "hired"
                ).length;
            }
            const spotsOpen = Math.max((jobToClose.needed || 1) - hiredCount, 0);
            const closeCount = closeDetails.closeCount ? parseInt(closeDetails.closeCount, 10) : 1;
            if (closeCount >= spotsOpen) {
                // Grey out the job in-place (mark closed: true) instead of removing it
                const dateClosed = closeDetails.dateClosed || new Date().toISOString();
                jobToClose.closed = true;
                jobToClose.dateClosed = dateClosed;
                jobToClose.closeReason = closeDetails.reason;
                const closedJobEntry = {
                    clientName: clientName,
                    position: jobToClose.position,
                    shift: jobToClose.shift,
                    description: jobToClose.description,
                    dateAdded: jobToClose.dateAdded,
                    dateClosed: dateClosed,
                    reason: closeDetails.reason,
                    candidate: closeDetails.candidate,
                    needed: jobToClose.needed,
                    candidates: jobToClose.candidates
                };
                if (!Array.isArray(closedJobsData)) { closedJobsData = []; }
                closedJobsData.push(closedJobEntry);
                saveClosedJobsChanges(closedJobsData);
                saveChanges(currentData);
            } else {
                // Partial close: reduce needed, add a closed job entry for the closed portion
                // 1. Clone the closed portion as a closed job
                const closedJobEntry = {
                    clientName: clientName,
                    position: jobToClose.position,
                    shift: jobToClose.shift,
                    description: jobToClose.description,
                    dateAdded: jobToClose.dateAdded,
                    dateClosed: closeDetails.dateClosed || new Date().toISOString(),
                    reason: closeDetails.reason,
                    candidate: closeDetails.candidate,
                    needed: closeCount,
                    candidates: jobToClose.candidates // Optionally, you could filter candidates here
                };
                if (!Array.isArray(closedJobsData)) { closedJobsData = []; }
                closedJobsData.push(closedJobEntry);
                // 2. Reduce needed on the open job
                jobToClose.needed = (jobToClose.needed || 1) - closeCount;
                if (jobToClose.needed < 1) jobToClose.needed = 1; // Prevent negative needed
                // 3. Save both
                saveClosedJobsChanges(closedJobsData);
                saveChanges(currentData);
            }
        } else {
            console.error(`[${socket.id}] Invalid indices (client: ${clientIndex}, job: ${jobIndex}) for close_job.`);
        }
    });

     socket.on('clear_closed_jobs', () => {
         console.log(`[${socket.id}] Received clear_closed_jobs`);
         closedJobsData = [];
         saveClosedJobsChanges(closedJobsData);
     });

     socket.on('update_priority', (payload) => {
        const { clientIndex, priority } = payload;
         console.log(`[${socket.id}] Received update_priority for index ${clientIndex} to ${priority}`);
        if (currentData && currentData[clientIndex]) {
            currentData[clientIndex].priority = priority;
            saveChanges(currentData);
        } else {
             console.error(`[${socket.id}] Invalid clientIndex (${clientIndex}) for update_priority.`);
        }
     });

    socket.on('update_urgent', (payload) => {
        const { clientIndex, urgent } = payload || {};
        if (currentData && currentData[clientIndex]) {
            currentData[clientIndex].urgent = !!urgent;
            saveChanges(currentData);
        } else {
            console.error(`[${socket.id}] Invalid clientIndex (${clientIndex}) for update_urgent.`);
        }
    });

    socket.on('add_bg_requirement_option', (option) => {
        const value = String(option || '').trim();
        if (!value || bgRequirementOptions.includes(value)) return;
        bgRequirementOptions.push(value);
        saveSettings();
        broadcastState();
    });

    // Re-open jobs from the closed-jobs log: bump an open posting of the same
    // position + shift, or add the job back as a new posting.
    socket.on('reopen_jobs', (jobs) => {
        let changed = false;
        for (const job of Array.isArray(jobs) ? jobs : []) {
            const client = currentData.find((c) => (c.name || '').toLowerCase() === (job.clientName || '').toLowerCase());
            if (!client) {
                console.warn(`[${socket.id}] Client "${job.clientName}" not found for reopen_jobs.`);
                continue;
            }
            if (!Array.isArray(client.jobs)) client.jobs = [];
            const open = client.jobs.find((j) => !j.closed &&
                (j.position || '').toLowerCase() === (job.position || '').toLowerCase() &&
                (j.shift || '').toLowerCase() === (job.shift || '').toLowerCase());
            if (open) {
                open.needed = (open.needed || 1) + 1;
            } else {
                client.jobs.push({
                    id: newId(),
                    position: job.position,
                    shift: job.shift,
                    needed: job.needed || 1,
                    description: job.description,
                    pay: job.pay || '',
                    startTime: job.startTime || '',
                    endTime: job.endTime || '',
                    candidates: Array.isArray(job.candidates) ? job.candidates : [],
                    dateAdded: new Date().toISOString(),
                    closed: false,
                });
            }
            changed = true;
        }
        if (changed) saveChanges(currentData);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// --- Server Initialization ---

function readFileSafely(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            // Basic check for non-empty content before parsing
            if (data && data.trim() !== '') {
                return JSON.parse(data);
            } else {
                 console.log(`${path.basename(filePath)} is empty, initializing with default.`);
            }
        }
    } catch (err) {
        console.error(`Error reading or parsing ${path.basename(filePath)}:`, err.message);
        // Optionally: Backup the corrupted file before overwriting
        // fs.copyFileSync(filePath, filePath + '.bak');
    }
    console.log(`${path.basename(filePath)} not found or invalid/empty, initializing with default.`);
    try {
         fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    } catch(writeErr) {
        console.error(`Error writing initial ${path.basename(filePath)}:`, writeErr);
    }
    return defaultValue;
}

// Load the board from appState/main. Failing that, take over an older
// bazingaClients collection, and failing that seed from the local JSON files.
async function loadState() {
    const list = (v) => (Array.isArray(v) ? v : []);
    const snap = await stateDoc.get();
    const state = snap.exists ? snap.data() : null;

    if (state && list(state.clients).length) {
        currentData = list(state.clients);
        closedJobsData = list(state.closedJobs);
        bgRequirementOptions = list(state.bgRequirementOptions);
        console.log(`Loaded ${currentData.length} clients from appState/main.`);
        lastWritten = JSON.stringify({ clients: currentData, closedJobs: closedJobsData, bgRequirementOptions });
    } else {
        const legacy = await legacyClientsCol.orderBy('order').get();
        if (!legacy.empty) {
            currentData = legacy.docs.map((d) => { const { order, ...client } = d.data(); return client; });
            console.log(`appState/main is empty; taking over ${currentData.length} clients from the older bazingaClients collection.`);
        } else {
            currentData = readFileSafely(filePath, []);
            if (!Array.isArray(currentData)) currentData = [];
            console.log(`Firestore is empty; seeding it with ${currentData.length} clients from ${path.basename(filePath)}.`);
        }
        closedJobsData = list(state && state.closedJobs);
        if (!closedJobsData.length) {
            closedJobsData = readFileSafely(closedJobsFilePath, []);
            if (!Array.isArray(closedJobsData)) closedJobsData = [];
        }
        bgRequirementOptions = list(state && state.bgRequirementOptions);
    }

    const missingIds = currentData.some((c) => !c.id || (c.jobs || []).some((j) => !j.id));
    ensureIds(currentData);
    if (lastWritten === null || missingIds) await persistState();

    // Live: the lobby app rewrites these whenever its job pools change.
    recommendedCol.onSnapshot((rs) => {
        const next = {};
        rs.forEach((d) => { next[d.id] = d.data().recommended || []; });
        recommendedByJob = next;
        broadcastState();
    }, (err) => console.error('Listening for recommended candidates failed:', err.message));
}

// Start the server once the data is loaded
loadState().catch((err) => {
    console.error('Could not load data from Firestore:', err.message);
    console.error('On a PC, run "gcloud auth application-default login" once, then start BAZINGA again.');
    process.exit(1);
}).then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    let localIp = null;
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
                break;
            }
        }
        if (localIp) break;
    }
     if(localIp) {
        console.log(`Access from other devices on the network (likely): http://${localIp}:${PORT}`);
     } else {
        console.log(`Could not determine local IP address.`);
     }
}));
