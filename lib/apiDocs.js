// Human-readable API reference served at /api/docs (also shown in the dashboard).
const S = '/api/services/:id';

module.exports = [
  { group: 'Authentication', auth: 'none', items: [
    ['GET', '/api/auth/status', 'Whether setup is needed and who is signed in'],
    ['POST', '/api/auth/setup', 'Create the first owner account { username, password }'],
    ['POST', '/api/auth/login', 'Sign in { username, password } → session cookie, or { mfaRequired, mfaToken }'],
    ['POST', '/api/auth/login/mfa', 'Finish sign-in with { mfaToken, code }'],
    ['POST', '/api/auth/logout', 'End the current session'],
    ['POST', '/api/auth/invite/:code', 'Accept an invite { username, password }']
  ] },
  { group: 'Services', items: [
    ['GET', '/api/services', 'List services with live state'],
    ['POST', '/api/services', 'Create { name, source: template|empty|git, templateId?, features?, gitUrl?, gitBranch?, gitToken?, type?, runtime?, entry? }'],
    ['GET', S, 'One service with git/webhook info, domains, diagnostics'],
    ['PATCH', S, 'Update settings (name, type, runtime, entry, command, restartPolicy, memoryLimitMb, autostart, healthCheck, sandbox, …)'],
    ['DELETE', S, 'Delete the service and its files (?keepBackups=1 keeps snapshots)'],
    ['POST', `${S}/start`, 'Start'], ['POST', `${S}/stop`, 'Stop'], ['POST', `${S}/restart`, 'Restart'],
    ['POST', `${S}/stdin`, 'Write a line to the process stdin { text }'],
    ['GET', `${S}/logs`, 'Recent log lines, or search with ?q=&stream=out|err|sys'],
    ['GET', `${S}/logs/download`, 'Download all retained logs'],
    ['GET', `${S}/metrics?range=1h|6h|24h|7d|30d`, 'CPU / memory / uptime history'],
    ['POST', `${S}/build`, 'Run the build command'],
    ['POST', `${S}/duplicate`, 'Copy the service { name }'],
    ['GET', `${S}/export`, 'Download code + settings as a ZIP (upload it into any service to import)'],
    ['GET', `${S}/activity`, 'Recent audit entries for this service']
  ] },
  { group: 'Files', items: [
    ['GET', `${S}/files/tree`, 'File & folder list'],
    ['GET', `${S}/files/content?path=`, 'Read a text file'],
    ['PUT', `${S}/files/content`, 'Write a file { path, content, expectedMtime?, restart? }'],
    ['POST', `${S}/files/upload`, 'Multipart upload (files[], paths[], dir, extract) — ZIPs are extracted safely'],
    ['POST', `${S}/files/mkdir`, 'Create folder { path }'],
    ['POST', `${S}/files/rename`, 'Move/rename { from, to }'],
    ['DELETE', `${S}/files?path=`, 'Delete a file or folder'],
    ['GET', `${S}/files/download?path=`, 'Download a file, or a folder as ZIP'],
    ['GET', `${S}/files/search?q=`, 'Search file contents']
  ] },
  { group: 'Environment', items: [
    ['GET', `${S}/env`, 'Variables (masked; ?reveal=1 to unmask)'],
    ['PATCH', `${S}/env`, 'Set/delete { vars: { KEY: "value" | null } }'],
    ['GET', '/api/env-groups', 'Shared variable groups'],
    ['POST', '/api/env-groups', 'Create group { name, vars }'],
    ['PATCH', '/api/env-groups/:gid', 'Update { name?, vars?, services? }']
  ] },
  { group: 'Packages & commands', items: [
    ['GET', `${S}/packages`, 'Dependencies and scripts'],
    ['POST', `${S}/install`, 'Install all dependencies'],
    ['POST', `${S}/packages`, 'Add { name, dev? }'],
    ['DELETE', `${S}/packages/:name`, 'Remove'],
    ['POST', `${S}/packages/upgrade`, 'Upgrade { name? }'],
    ['POST', `${S}/packages/audit`, 'Security audit (npm audit / pip check)'],
    ['POST', `${S}/packages/audit-fix`, 'npm audit fix (no breaking upgrades)'],
    ['POST', `${S}/run-script`, 'Run a package.json script { script }'],
    ['POST', `${S}/exec`, 'Run a one-off command { command } (admins)']
  ] },
  { group: 'Deploys & backups', items: [
    ['PUT', `${S}/git`, 'Configure repo { url, branch, token?, autoDeploy? }'],
    ['POST', `${S}/git/deploy`, 'Clone or pull, install, restart'],
    ['GET', `${S}/deploys`, 'Deploy history'],
    ['POST', `${S}/deploys/:did/rollback`, 'Roll back to a deploy snapshot'],
    ['GET', `${S}/backups`, 'Snapshots'], ['POST', `${S}/backups`, 'Create snapshot'],
    ['POST', `${S}/backups/:bid/restore`, 'Restore snapshot'],
    ['POST', '/api/hooks/github/:id', 'GitHub push webhook (HMAC X-Hub-Signature-256)']
  ] },
  { group: 'Schedules, data & tools', items: [
    ['GET', `${S}/schedules`, 'Cron jobs'], ['POST', `${S}/schedules`, 'Add { cron, action: restart|start|stop|backup|deploy|command, command? }'],
    ['GET', `${S}/sqlite`, 'Built-in SQLite tables'], ['POST', `${S}/sqlite/query`, 'Run SQL { sql, readOnly? }'],
    ['GET', `${S}/discord`, 'Bot profile, guild count, intents check'],
    ['GET', `${S}/discord/guilds`, 'Servers the bot is in'],
    ['DELETE', `${S}/discord/guilds/:gid`, 'Make the bot leave a server'],
    ['POST', `${S}/features`, 'Add a feature pack { feature }'],
    ['POST', `${S}/ai/analyze`, 'AI crash analysis (needs ANTHROPIC_API_KEY)']
  ] },
  { group: 'Panel', items: [
    ['GET', '/api/system/overview', 'Host & service summary'],
    ['GET', '/api/system/notifications', 'Notification center'],
    ['GET', '/api/system/audit', 'Audit log (admins)'],
    ['GET', '/api/system/domains', 'Custom domains'], ['POST', '/api/system/domains', 'Map { domain, serviceId }'],
    ['GET', '/api/users', 'Users (admins)'], ['POST', '/api/users/invites', 'Create invite { role, services?, days? }'],
    ['POST', '/api/account/tokens', 'Create a personal API token { name }'],
    ['GET', '/api/monitors', 'Uptime monitors with status and history'],
    ['POST', '/api/monitors', 'Add { name, type: http|keyword|tcp, url | host+port, keyword?, intervalSec?, statusPage? } (admins)'],
    ['POST', '/api/monitors/:mid/check', 'Check now'],
    ['GET', '/api/system/export?backups=1', 'Download a full panel export (owner)'],
    ['POST', '/api/system/import', 'Import a panel export, multipart field "file" (owner)'],
    ['GET', '/api/public/status', 'Public status page data (no auth)']
  ] }
];
