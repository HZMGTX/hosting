// Discord REST helpers: bot profile, token check, intents comparison.
const fs = require('fs');
const path = require('path');
const services = require('./services');
const envFile = require('./envFile');
const { httpError } = require('./errors');

const API = 'https://discord.com/api/v10';

// Application flag bits for privileged intents.
const FLAGS = {
  GATEWAY_PRESENCE: 1 << 12, GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14, GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18, GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19
};

function tokenFor(svc) {
  const vars = { ...services.groupVars(svc), ...envFile.readVars(services.envPath(svc.id)) };
  return vars.DISCORD_BOT_TOKEN || vars.DISCORD_TOKEN || '';
}

async function call(token, route) {
  const res = await fetch(API + route, { headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (OmniHost, 2.0)' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw httpError(400, 'Discord rejected this token (401). Reset it in the Developer Portal and update DISCORD_BOT_TOKEN.');
  if (!res.ok) throw httpError(502, `Discord API answered ${res.status}`);
  return res.json();
}

// Look through the code for intents the bot asks for.
function scanIntents(dir) {
  const found = { members: false, presence: false, messageContent: false };
  const walk = (d, depth = 0) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (['node_modules', '.git', '.venv', '__pycache__'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(m?js|cjs|ts|py)$/.test(e.name)) {
        let src = '';
        try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (/GuildMembers|GUILD_MEMBERS|intents\.members\s*=\s*True|Intents\.all\(\)|['"]GuildMembers['"]/.test(src)) found.members = true;
        if (/GuildPresences|GUILD_PRESENCES|intents\.presences\s*=\s*True|Intents\.all\(\)/.test(src)) found.presence = true;
        if (/MessageContent|MESSAGE_CONTENT|intents\.message_content\s*=\s*True|Intents\.all\(\)/.test(src)) found.messageContent = true;
      }
    }
  };
  walk(dir);
  return found;
}

async function profile(svc) {
  const token = tokenFor(svc);
  if (!token) throw httpError(400, 'No DISCORD_BOT_TOKEN set for this service');
  const [user, app] = await Promise.all([call(token, '/users/@me'), call(token, '/applications/@me')]);
  const flags = app.flags || 0;
  const enabled = {
    presence: !!(flags & (FLAGS.GATEWAY_PRESENCE | FLAGS.GATEWAY_PRESENCE_LIMITED)),
    members: !!(flags & (FLAGS.GATEWAY_GUILD_MEMBERS | FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED)),
    messageContent: !!(flags & (FLAGS.GATEWAY_MESSAGE_CONTENT | FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED))
  };
  const used = scanIntents(services.dir(svc.id));
  const problems = Object.keys(used).filter(k => used[k] && !enabled[k]);
  return {
    user: {
      id: user.id, username: user.username, discriminator: user.discriminator,
      avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null
    },
    application: {
      id: app.id, name: app.name, description: app.description || '',
      guildCount: app.approximate_guild_count ?? null, public: !!app.bot_public
    },
    intents: { enabled, used, problems }
  };
}

async function guilds(svc) {
  const token = tokenFor(svc);
  if (!token) throw httpError(400, 'No DISCORD_BOT_TOKEN set for this service');
  const list = await call(token, '/users/@me/guilds?with_counts=true&limit=200');
  return list.map(g => ({
    id: g.id, name: g.name,
    iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
    members: g.approximate_member_count ?? null, online: g.approximate_presence_count ?? null
  }));
}

async function leaveGuild(svc, guildId) {
  const token = tokenFor(svc);
  if (!token) throw httpError(400, 'No DISCORD_BOT_TOKEN set for this service');
  const res = await fetch(`${API}/users/@me/guilds/${guildId}`, { method: 'DELETE', headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (OmniHost, 2.0)' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok && res.status !== 204) throw httpError(502, `Discord answered ${res.status}`);
}

module.exports = { profile, scanIntents, tokenFor, guilds, leaveGuild };
