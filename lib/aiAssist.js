// Optional AI crash assistant: sends recent errors + the relevant source file to Claude and
// gets back an explanation plus search/replace edits. Only active when ANTHROPIC_API_KEY is set.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const services = require('./services');
const logStore = require('./logStore');
const { resolveInside } = require('./safePath');
const { httpError } = require('./errors');

const MAX_FILE_CHARS = 120000;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'file', 'edits'],
  properties: {
    explanation: { type: 'string', description: 'Plain-language cause of the error and what the fix does' },
    file: { type: 'string', description: 'Relative path of the file the edits apply to, or empty if no code change is needed' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['search', 'replace'],
        properties: {
          search: { type: 'string', description: 'Exact text copied from the file, unique within it' },
          replace: { type: 'string' }
        }
      }
    }
  }
};

let client = null;
function getClient() {
  if (!config.ANTHROPIC_API_KEY) throw httpError(400, 'AI assistant is disabled — set ANTHROPIC_API_KEY on the server to enable it');
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

function enabled() {
  return !!config.ANTHROPIC_API_KEY;
}

// Pick the file most likely involved: one named in a stack trace, else the entry file.
function guessFile(svc, errorText) {
  const dir = services.dir(svc.id);
  const re = /([\w./\\-]+\.(?:m?js|cjs|ts|py))(?::(\d+))?/g;
  let m;
  while ((m = re.exec(errorText))) {
    let candidate = m[1].replace(/\\/g, '/');
    if (candidate.includes('node_modules') || candidate.startsWith('node:')) continue;
    const idx = candidate.indexOf(`/hosted_bots/${svc.id}/`);
    if (idx >= 0) candidate = candidate.slice(idx + `/hosted_bots/${svc.id}/`.length);
    try {
      const full = resolveInside(dir, candidate);
      if (fs.existsSync(full)) return candidate;
    } catch {}
  }
  return svc.entry;
}

async function analyze(id, { file: requestedFile } = {}) {
  const svc = services.get(id);
  const errors = logStore.history(id).filter(e => e.s !== 'out').slice(-60).map(e => logStore.stripAnsi(e.m)).join('\n');
  if (!errors.trim()) throw httpError(400, 'There are no recent errors in the console to analyze');
  const relFile = requestedFile || guessFile(svc, errors);
  let source = '';
  try { source = fs.readFileSync(resolveInside(services.dir(id), relFile), 'utf8'); } catch {}
  if (source.length > MAX_FILE_CHARS) throw httpError(400, `${relFile} is too large to send (${Math.round(source.length / 1000)}k chars)`);
  const pkg = services.readPackageJson(id);

  const prompt = [
    `A ${svc.runtime === 'python' ? 'Python' : 'Node.js'} ${svc.type} service hosted on OmniHost is failing.`,
    `Entry file: ${svc.entry}`,
    pkg ? `package.json dependencies: ${JSON.stringify(pkg.dependencies || {})}` : '',
    '',
    'Recent console errors:',
    '<logs>', errors, '</logs>',
    '',
    source ? `Contents of ${relFile}:\n<file path="${relFile}">\n${source}\n</file>` : `(Could not read ${relFile}.)`,
    '',
    `Explain the cause briefly for a hobbyist developer. If a code change in ${relFile} fixes it, return minimal search/replace edits whose "search" text is copied exactly from the file and occurs once. If the fix is outside the code (token, intents, missing package, environment variable), explain the steps and return no edits.`
  ].filter(s => s !== null).join('\n');

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: config.OMNI_AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    });
  } catch (e) {
    const Anthropic = require('@anthropic-ai/sdk');
    const A = Anthropic.default || Anthropic;
    if (e instanceof A.AuthenticationError) throw httpError(502, 'The Anthropic API key was rejected');
    if (e instanceof A.RateLimitError) throw httpError(429, 'The AI assistant is rate limited — try again in a minute');
    if (e instanceof A.APIError) throw httpError(502, `AI request failed (${e.status || 'network'}): ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw httpError(422, 'The AI declined to analyze this request');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let result;
  try { result = JSON.parse(text); } catch { throw httpError(502, 'The AI returned an unreadable answer — try again'); }
  const edits = (result.edits || []).filter(e => e && typeof e.search === 'string' && e.search && typeof e.replace === 'string');
  const file = result.file || (edits.length ? relFile : '');
  // Check each edit applies cleanly so the UI only offers working patches.
  let current = '';
  if (file) { try { current = fs.readFileSync(resolveInside(services.dir(id), file), 'utf8'); } catch {} }
  const checked = edits.map(e => ({ ...e, applies: current.split(e.search).length === 2 }));
  return { explanation: result.explanation, file, edits: checked, model: response.model };
}

function applyEdits(id, file, edits) {
  const full = resolveInside(services.dir(id), file);
  let text = fs.readFileSync(full, 'utf8');
  for (const e of edits) {
    const parts = text.split(e.search);
    if (parts.length !== 2) throw httpError(409, 'The file changed since the suggestion was made — ask again');
    text = parts.join(e.replace);
  }
  fs.writeFileSync(full, text, 'utf8');
  logStore.append(id, 'sys', `Applied ${edits.length} AI-suggested edit(s) to ${file}.`);
  return { file: path.basename(full) };
}

module.exports = { enabled, analyze, applyEdits };
