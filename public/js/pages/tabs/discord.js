// Discord tools: live bot profile, intents check, invite-link builder, feature packs, command registration.
import { h, icon, mount, btn, toast, busy, copyField, badge, confirmDialog } from '../../ui.js';
import { api, svcUrl } from '../../api.js';
import { store } from '../../store.js';
import { navigate } from '../../router.js';

const PERMS = [
  ['Administrator', 3, 'Everything (avoid unless needed)'],
  ['View Channels', 10], ['Send Messages', 11], ['Send Messages in Threads', 38], ['Embed Links', 14], ['Attach Files', 15],
  ['Read Message History', 16], ['Add Reactions', 6], ['Use External Emojis', 18], ['Manage Messages', 13],
  ['Manage Channels', 4], ['Manage Roles', 28], ['Kick Members', 1], ['Ban Members', 2], ['Moderate Members (timeout)', 40],
  ['Manage Nicknames', 27], ['Connect (voice)', 20], ['Speak (voice)', 21], ['Mention Everyone', 17], ['Manage Webhooks', 29]
];
const PRESETS = { Basic: [10, 11, 14, 15, 16, 6, 18], Moderation: [10, 11, 14, 16, 13, 1, 2, 40, 27, 28], Tickets: [10, 11, 14, 16, 4, 28] };

export async function discordTab(root, svc) {
  const id = svc.id;
  const canEdit = store.can('edit', id);
  const profileBox = h('div', null, h('div', { class: 'skeleton', style: { height: '80px' } }));
  const selected = new Set(PRESETS.Basic);
  let clientId = '';
  const linkBox = h('div');

  function renderLink() {
    let bits = 0n;
    for (const b of selected) bits |= 1n << BigInt(b);
    const url = clientId ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${bits}&integration_type=0&scope=bot+applications.commands` : '';
    mount(linkBox, url
      ? h('div', null, copyField(url), h('div', { class: 'row mt-sm' }, h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, icon('external', 15), 'Open invite page'), h('span', { class: 'small muted' }, `Permissions integer: ${bits}`)))
      : h('p', { class: 'small muted' }, 'Set a valid token (the application ID is read from it) or CLIENT_ID to build the link.'));
  }

  async function loadProfile() {
    if (!canEdit) return mount(profileBox, h('p', { class: 'muted small' }, 'Only editors can query Discord with this bot\'s token.'));
    try {
      const p = await api.get(svcUrl(id, '/discord'));
      clientId = p.application.id;
      renderLink();
      const intentRow = (key, label) => {
        const used = p.intents.used[key], on = p.intents.enabled[key];
        return h('div', { class: 'list-item small' }, h('span', { class: 'grow' }, label),
          used ? badge('used in code', 'info') : badge('not used'),
          on ? badge('enabled', 'success') : badge('disabled', used ? 'danger' : ''));
      };
      mount(profileBox,
        h('div', { class: 'row gap-lg mb' },
          p.user.avatarUrl ? h('img', { src: p.user.avatarUrl, alt: '', width: 64, height: 64, style: { borderRadius: '50%' } }) : h('div', { class: 'svc-icon discord', style: { width: '64px', height: '64px' } }, icon('bot', 30)),
          h('div', null,
            h('h2', null, p.user.username, p.user.discriminator && p.user.discriminator !== '0' ? `#${p.user.discriminator}` : ''),
            h('div', { class: 'small muted' }, `Application: ${p.application.name} · ID ${p.application.id}`),
            h('div', { class: 'row mt-sm' }, badge('Token valid', 'success'), p.application.guildCount !== null ? badge(`${p.application.guildCount} server(s)`, 'accent') : null, badge(p.application.public ? 'Public bot' : 'Private bot')))),
        h('h3', { class: 'mb-sm' }, 'Privileged intents'),
        h('div', { class: 'list' }, intentRow('messageContent', 'Message Content'), intentRow('members', 'Server Members'), intentRow('presence', 'Presence')),
        p.intents.problems.length ? h('div', { class: 'callout error mt' }, icon('alert', 16), h('div', { class: 'callout-body' },
          h('strong', null, 'The bot will be disconnected with "Used disallowed intents"'),
          h('p', null, 'Enable the intents marked red in the Developer Portal → Bot → Privileged Gateway Intents, or remove them from the code.')),
          h('a', { class: 'btn sm', href: `https://discord.com/developers/applications/${p.application.id}/bot`, target: '_blank', rel: 'noopener' }, 'Open portal')) : null);
    } catch (e) {
      mount(profileBox, h('div', { class: 'callout warning' }, icon('key', 18), h('div', { class: 'callout-body' }, h('strong', null, 'Cannot read the bot profile'), h('p', null, e.message)),
        btn('Edit token', { size: 'sm', onClick: () => navigate(`/services/${id}/env?focus=DISCORD_BOT_TOKEN`) })));
      try {
        const env = await api.get(svcUrl(id, '/env'));
        const c = env.vars.find(v => v.key === 'CLIENT_ID' || v.key === 'APPLICATION_ID');
        if (c && /^\d{15,25}$/.test(c.value)) { clientId = c.value; renderLink(); }
      } catch {}
    }
  }

  const permBoxes = h('div', { class: 'grid cols-2', style: { gap: '0.15rem 1rem' } });
  function renderPerms() {
    mount(permBoxes, PERMS.map(([label, bit, hint]) => h('label', { class: 'check', style: { marginBottom: '0.25rem' } },
      h('input', { type: 'checkbox', checked: selected.has(bit), onChange: e => { e.target.checked ? selected.add(bit) : selected.delete(bit); renderLink(); } }),
      h('span', { class: 'small' }, label, hint ? h('span', { class: 'desc' }, hint) : null))));
  }
  renderPerms();
  renderLink();

  // Feature packs (only for the slash-command template layout).
  let featureCard = null;
  if (svc.supportsFeatures && canEdit) {
    const { features } = await api.get('/api/services/templates');
    featureCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('sparkles', 18), 'Feature packs'), h('p', null, 'Drop-in slash commands and events, added as separate files you can edit.'))),
      h('div', { class: 'list' }, features.map(f => {
        const add = btn('Add', { size: 'sm', icon: 'plus' });
        add.addEventListener('click', busy(add, async () => {
          await api.post(svcUrl(id, '/features'), { feature: f.id });
          toast(`${f.name} added. Restart the bot and register commands.`, 'success');
          add.disabled = true;
          add.textContent = 'Added';
        }));
        return h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, f.name), h('div', { class: 'small muted' }, f.description)), add);
      })));
  }

  // Servers the bot is in, with member counts and a leave action.
  const guildBox = h('div', null, h('div', { class: 'skeleton', style: { height: '60px' } }));
  const guildCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('users', 18), 'Servers'), h('p', null, 'Every server this bot has joined.')),
      btn('', { size: 'sm', variant: 'ghost', icon: 'refresh', title: 'Refresh', onClick: () => loadGuilds() })),
    guildBox);
  async function loadGuilds() {
    try {
      const list = await api.get(svcUrl(id, '/discord/guilds'));
      mount(guildBox, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Server'), h('th', null, 'Members'), h('th', null, 'Online'), h('th', null, ''))),
        h('tbody', null, list.map(g => {
          const leave = btn('Leave', { size: 'sm', variant: 'danger' });
          leave.addEventListener('click', busy(leave, async () => {
            if (!(await confirmDialog(`Make the bot leave "${g.name}"?`, { okLabel: 'Leave server', danger: true, detail: 'It can only rejoin with a new invite from a server admin.' }))) return;
            await api.del(svcUrl(id, `/discord/guilds/${g.id}`));
            toast(`Left ${g.name}`, 'success');
            loadGuilds();
          }));
          return h('tr', null,
            h('td', null, h('div', { class: 'row' }, g.iconUrl ? h('img', { src: g.iconUrl, alt: '', width: 24, height: 24, style: { borderRadius: '50%' } }) : icon('users', 18), h('span', null, g.name), h('span', { class: 'tiny faint mono' }, g.id))),
            h('td', { class: 'mono small' }, g.members ?? '—'),
            h('td', { class: 'mono small' }, g.online ?? '—'),
            h('td', { class: 'actions' }, leave));
        })))) : h('p', { class: 'small muted' }, 'The bot is not in any server yet. Use the invite link above.'));
    } catch (e) {
      mount(guildBox, h('p', { class: 'small muted' }, e.message));
    }
  }

  const registerBtn = btn('Register slash commands', { icon: 'zap', disabled: !canEdit });
  registerBtn.addEventListener('click', busy(registerBtn, async () => {
    const pkg = await api.get(svcUrl(id, '/packages'));
    if (!pkg.scripts || !pkg.scripts.deploy) throw new Error('This bot has no "deploy" script in package.json. Bots from the simple template register commands on startup.');
    toast('Registering… see the console', 'info');
    const r = await api.post(svcUrl(id, '/run-script'), { script: 'deploy' });
    toast(r.ok ? 'Commands registered' : 'Registration failed — see the console', r.ok ? 'success' : 'error');
  }));

  mount(root,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, icon('bot', 18), 'Bot profile'), btn('', { size: 'sm', variant: 'ghost', icon: 'refresh', title: 'Refresh', onClick: loadProfile })), profileBox,
        h('div', { class: 'form-actions' }, registerBtn)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, icon('link', 18), 'Invite link'), h('p', null, 'Pick what the bot may do in a server.')),
          h('div', { class: 'btn-group' }, Object.keys(PRESETS).map(k => btn(k, { size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); PRESETS[k].forEach(b => selected.add(b)); renderPerms(); renderLink(); } })))),
        permBoxes, h('hr'), linkBox)),
    canEdit ? guildCard : null,
    featureCard);
  loadProfile();
  if (canEdit) loadGuilds();
}
