const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // Ensure you've installed this: npm install cors
const multer = require('multer');

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

// --- Helper Functions for Saving and Broadcasting ---

// Saves the current client data and broadcasts the full state
function saveChanges(data) {
    currentData = data; // Update server's in-memory state immediately
    fs.writeFile(filePath, JSON.stringify(currentData, null, 2), (err) => {
        if (err) {
            console.error('Error saving client changes:', err);
        } else {
            console.log('Client changes saved to', filePath);
            // Broadcast the combined state whenever clients change
            io.emit('change', { clients: currentData, closedJobs: closedJobsData });
        }
    });
}

// Saves the closed jobs data and broadcasts the full state
function saveClosedJobsChanges(data) {
    closedJobsData = data; // Update server's in-memory state
    fs.writeFile(closedJobsFilePath, JSON.stringify(closedJobsData, null, 2), (err) => {
        if (err) {
            console.error('Error saving closed jobs changes:', err);
        } else {
            console.log('Closed jobs saved to', closedJobsFilePath);
             // Broadcast the combined state whenever closed jobs change
            io.emit('change', { clients: currentData, closedJobs: closedJobsData });
        }
    });
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send the current state (clients and closed jobs) to the newly connected client
    socket.emit('initial_state', { clients: currentData, closedJobs: closedJobsData });

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

// Read initial data safely
currentData = readFileSafely(filePath, []);
closedJobsData = readFileSafely(closedJobsFilePath, []);

// Ensure data is array
if (!Array.isArray(currentData)) {
    console.warn("Client data file was not an array, re-initializing.");
    currentData = [];
    fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2));
}
if (!Array.isArray(closedJobsData)) {
     console.warn("Closed jobs data file was not an array, re-initializing.");
    closedJobsData = [];
     fs.writeFileSync(closedJobsFilePath, JSON.stringify(closedJobsData, null, 2));
}


// Start the server
server.listen(PORT, '0.0.0.0', () => {
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
});