// Durable JSON store with atomic writes. Jobs survive restarts so work resumes.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'jobs.json');

let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { jobs = []; }

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}
function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(jobs));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('Could not save jobs:', e.message); // keep running; next save retries
  }
}

module.exports = {
  all: () => jobs,
  get: id => jobs.find(j => j.id === id),
  add: job => { jobs.unshift(job); save(); },
  remove: id => { jobs = jobs.filter(j => j.id !== id); save(); },
  save,
  flush,
};
