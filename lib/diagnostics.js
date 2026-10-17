// Real "auto-fix": recognise common crash messages and turn them into an explanation + action.
const bus = require('./bus');

const PORTAL = 'https://discord.com/developers/applications';

// Each rule: id, pattern, and build(match, context) -> { title, explain, action? }
const RULES = [
  {
    id: 'token-invalid',
    test: /TokenInvalid|An invalid token was provided|TOKEN_INVALID|Improper token has been passed|LoginFailure/i,
    build: () => ({
      title: 'Discord rejected the bot token',
      explain: 'The token is wrong, was reset, or has extra spaces. Copy a fresh token from the Developer Portal (Bot → Reset Token) and save it as DISCORD_BOT_TOKEN.',
      action: { type: 'open-env', label: 'Edit token', key: 'DISCORD_BOT_TOKEN' },
      level: 'error'
    })
  },
  {
    id: 'token-missing',
    test: /TokenMissing|Expected token to be set|No token (was )?provided|DISCORD_(BOT_)?TOKEN (is )?(not set|missing|empty)|Cannot start: DISCORD_BOT_TOKEN/i,
    build: () => ({
      title: 'No bot token is set',
      explain: 'The bot started without a token. Add DISCORD_BOT_TOKEN in the Environment tab, then start it again.',
      action: { type: 'open-env', label: 'Add token', key: 'DISCORD_BOT_TOKEN' },
      level: 'error'
    })
  },
  {
    id: 'telegram-token',
    test: /TELEGRAM_BOT_TOKEN is empty|Call to 'getMe' failed!? \(401|401: Unauthorized.*telegram/i,
    build: () => ({
      title: 'Telegram bot token is missing or wrong',
      explain: 'Message @BotFather on Telegram, run /token (or /newbot), and save the token as TELEGRAM_BOT_TOKEN.',
      action: { type: 'open-env', label: 'Edit token', key: 'TELEGRAM_BOT_TOKEN' },
      level: 'error'
    })
  },
  {
    id: 'disallowed-intents',
    test: /Used disallowed intents|DisallowedIntents|privileged intents?.*not enabled|PrivilegedIntentsRequired/i,
    build: () => ({
      title: 'Privileged intents are not enabled',
      explain: 'The code asks for Message Content, Server Members or Presence intents that are switched off. Enable them under Bot → Privileged Gateway Intents in the Developer Portal, or remove them from the code.',
      action: { type: 'open-url', label: 'Open Developer Portal', url: PORTAL },
      level: 'error'
    })
  },
  {
    id: 'missing-node-module',
    test: /Cannot find (?:module|package) '([^']+)'/,
    build: m => {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('node:')) {
        return { title: `A local file is missing: ${spec}`, explain: 'A require/import points to a file that does not exist. Check the path and file name (they are case-sensitive on Linux).', level: 'error' };
      }
      const parts = spec.split('/');
      const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      return {
        title: `Package "${pkg}" is not installed`,
        explain: `The code uses "${pkg}" but it is not in node_modules. Install it (it will also be added to package.json).`,
        action: { type: 'install-package', label: `Install ${pkg}`, name: pkg },
        level: 'error'
      };
    }
  },
  {
    id: 'missing-python-module',
    test: /ModuleNotFoundError: No module named '([^'.]+)/,
    build: m => {
      const map = { discord: 'discord.py', dotenv: 'python-dotenv', yaml: 'pyyaml', PIL: 'pillow', cv2: 'opencv-python', sklearn: 'scikit-learn', bs4: 'beautifulsoup4' };
      const pkg = map[m[1]] || m[1];
      return {
        title: `Python package "${pkg}" is not installed`,
        explain: `Install "${pkg}" (it will also be added to requirements.txt).`,
        action: { type: 'install-package', label: `pip install ${pkg}`, name: pkg },
        level: 'error'
      };
    }
  },
  {
    id: 'port-in-use',
    test: /EADDRINUSE[^\n]*?:(\d+)/,
    build: m => ({
      title: `Port ${m[1]} is already in use`,
      explain: 'Another process holds this port. Web services must listen on process.env.PORT, which OmniHost assigns for you.',
      action: { type: 'open-tab', label: 'Open settings', tab: 'settings' },
      level: 'error'
    })
  },
  {
    id: 'heap-oom',
    test: /JavaScript heap out of memory|FATAL ERROR: .*Allocation failed/i,
    build: () => ({
      title: 'Out of memory',
      explain: 'The process hit its memory limit. Raise the memory limit in Settings or look for leaks (huge caches, unbounded arrays).',
      action: { type: 'open-tab', label: 'Raise memory limit', tab: 'settings' },
      level: 'error'
    })
  },
  {
    id: 'missing-access',
    test: /DiscordAPIError\[50001\]|Missing Access/,
    build: () => ({
      title: 'The bot cannot see that channel or server',
      explain: 'Discord says "Missing Access". Re-invite the bot with the right scopes (bot + applications.commands) or give its role access to the channel.',
      action: { type: 'open-tab', label: 'Invite link builder', tab: 'discord' },
      level: 'warning'
    })
  },
  {
    id: 'missing-permissions',
    test: /DiscordAPIError\[50013\]|Missing Permissions/,
    build: () => ({
      title: 'The bot is missing permissions',
      explain: 'Discord refused the action. Give the bot\'s role the needed permission and make sure it sits above the roles it manages.',
      action: { type: 'open-tab', label: 'Invite link builder', tab: 'discord' },
      level: 'warning'
    })
  },
  {
    id: 'unknown-interaction',
    test: /DiscordAPIError\[10062\]|Unknown interaction/,
    build: () => ({
      title: 'Interaction expired before the bot replied',
      explain: 'Discord gives 3 seconds to answer a slash command. Call interaction.deferReply() first when the command does slow work.',
      level: 'warning'
    })
  },
  {
    id: 'rate-limited',
    test: /You are being rate limited|429 Too Many Requests/i,
    build: () => ({ title: 'Rate limited by Discord', explain: 'Too many requests too fast. Slow down loops that send messages or edit roles.', level: 'warning' })
  },
  {
    id: 'econnrefused',
    test: /ECONNREFUSED\s+([\d.:a-zA-Z[\]]+)/,
    build: m => ({ title: `Could not connect to ${m[1]}`, explain: 'A database or API the service depends on is not reachable. Check its connection string in the Environment tab.', action: { type: 'open-tab', label: 'Open environment', tab: 'env' }, level: 'error' })
  },
  {
    id: 'python-missing',
    test: /spawn (python3?|py) ENOENT/,
    build: () => ({ title: 'Python is not installed on this host', explain: 'Install Python 3 (the Docker image already includes it) or switch the runtime to Node.js.', level: 'error' })
  },
  {
    id: 'syntax-error',
    test: /^(SyntaxError|IndentationError|TabError)\b.*/,
    build: (m, ctx) => {
      const loc = findLocation(ctx.recent);
      return {
        title: `${m[1]} in your code`,
        explain: loc ? `Check ${loc.file} around line ${loc.line}.` : 'The code has a syntax error. The lines above show where.',
        action: loc ? { type: 'open-file', label: `Open ${loc.file}:${loc.line}`, path: loc.file, line: loc.line } : undefined,
        level: 'error'
      };
    }
  },
  {
    id: 'unhandled-rejection',
    test: /UnhandledPromiseRejection|Unhandled promise rejection/i,
    build: () => ({ title: 'An async error was not caught', explain: 'Add try/catch (or .catch()) around awaited Discord calls so one failure does not crash the bot.', level: 'warning' })
  }
];

function findLocation(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/([\w./\\-]+\.(?:m?js|cjs|ts|py)):(\d+)/) || lines[i].match(/File "([^"]+)", line (\d+)/);
    if (m) {
      const file = m[1].replace(/\\/g, '/');
      const rel = file.includes('/hosted_bots/') ? file.split('/hosted_bots/')[1].split('/').slice(1).join('/') : file.replace(/^\.\//, '');
      return { file: rel, line: parseInt(m[2], 10) };
    }
  }
  return null;
}

const state = new Map(); // serviceId -> { recent: [], seen: Map(ruleId -> time), active: [] }

function ctx(id) {
  let c = state.get(id);
  if (!c) { c = { recent: [], seen: new Map(), active: [] }; state.set(id, c); }
  return c;
}

function scan(serviceId, line) {
  const c = ctx(serviceId);
  c.recent.push(line);
  if (c.recent.length > 20) c.recent.shift();
  for (const rule of RULES) {
    const m = line.match(rule.test);
    if (!m) continue;
    const last = c.seen.get(rule.id) || 0;
    if (Date.now() - last < 30000) return null;
    c.seen.set(rule.id, Date.now());
    const d = { id: rule.id, at: new Date().toISOString(), line: line.slice(0, 300), ...rule.build(m, c) };
    c.active = c.active.filter(x => x.id !== d.id);
    c.active.push(d);
    if (c.active.length > 10) c.active.shift();
    bus.emit('diagnostic', { serviceId, diagnostic: d });
    return d;
  }
  return null;
}

function list(serviceId) {
  return ctx(serviceId).active;
}

function recentLines(serviceId) {
  return ctx(serviceId).recent.slice();
}

function clear(serviceId) {
  const c = ctx(serviceId);
  c.active = [];
  c.seen.clear();
}

function dismiss(serviceId, ruleId) {
  const c = ctx(serviceId);
  c.active = c.active.filter(d => d.id !== ruleId);
}

module.exports = { scan, list, clear, dismiss, recentLines, RULES };
