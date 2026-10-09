# BAZINGA

Recruiter job board: clients, their open positions, candidates, dispatch
sheets and the closed-jobs log. `server.js` (Express + Socket.IO) serves
`public/index.html` and keeps every open browser in sync.

## Data: Firebase (Firestore)

Data is stored in Firestore in the **bazingaopens** project (override with
`FIRESTORE_PROJECT`):

| Collection / doc | Contents |
| --- | --- |
| `bazingaClients/{clientId}` | One client, its `jobs` array, and its list `order` |
| `bazingaState/closedJobs` | `{ items: [...] }`, the closed-jobs log |
| `bazingaState/settings` | `{ bgRequirementOptions: [...] }` |
| `bazingaRecommended/{jobId}` | **Written by the lobby app**: applicants matched to that job |

Every client and job has a permanent `id`. The lobby app uses the job `id` to
attach Recommended candidates, so ids are never changed by edits.

`changes.json` and `closed_jobs.json` are still written next to `server.js` as a
local backup. The first time this version starts against an empty Firestore, it
copies them into Firestore.

### Running it

- **On Cloud Run / Firebase Hosting** (the `bazinga-app` service): nothing to
  set up. The service account reaches Firestore automatically.
- **On a PC**: install the Google Cloud CLI and run
  `gcloud auth application-default login` once with an account that can access
  `bazingaopens`, then `npm start`.

One-time: Firestore must be enabled in the bazingaopens project (Firebase
console → Firestore Database → Create database).

## Recommended

Each job shows a **Recommended** list below Candidates: applicants from the
lobby app (2026Lobby) whose shift, pay, location and skills fit the job, with a
match score out of 100. Hover a name for phone, email and why they matched. The
list updates live as the lobby app's pools change.

For the lobby app to read jobs and write Recommended, give its service account
access to this project once:

```bash
gcloud projects add-iam-policy-binding bazingaopens \
  --member="serviceAccount:project-877472760654383082@appspot.gserviceaccount.com" \
  --role="roles/datastore.user"
```

## Updating the list from a file

`import-list.js` merges a job list (an array of clients in the `changes.json`
format) into Firestore without replacing what is there. Nothing is deleted.

```bash
node import-list.js list.json                  # dry run: shows what would change
node import-list.js list.json --apply --status # write it, and copy open/closed status

# or take the list straight from the live site's own saved data (collection appState):
node import-list.js --from-appstate                    # dry run
node import-list.js --from-appstate --apply --status    # write it
```

New clients and jobs are added, missing candidates are added to matching jobs,
and empty client fields are filled in. With `--status`, a job's open/closed state
is taken from the list. `--from-appstate` only reads the `appState` collection,
never writes to it; it looks through every document there for a list of clients
(stored as a list or as JSON text) and names them, so `--source
appState/<doc>.<field>` can pick one when there is more than one. Before writing, the existing versions of every client it
changes are saved to `bazinga-backup-<time>.json`. Stop BAZINGA first (the PC copy
and the Cloud Run service) and start or redeploy it afterwards, because a running
server keeps its own copy in memory.
