// Discord.js v14 bot with file-based slash commands and events.
// commands/*.js export { data, execute } (or an array of them); events/*.js export { name, once?, execute }.
const fs = require('fs');
const path = require('path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Cannot start: DISCORD_BOT_TOKEN is empty. Add it in the Environment tab.');
  process.exit(1);
}

function loadModules(dir) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(f => f.endsWith('.js'))
    .flatMap(f => {
      const mod = require(path.join(full, f));
      return Array.isArray(mod) ? mod : [mod];
    });
}

const commandModules = loadModules('commands');
const eventModules = loadModules('events');

// Ask only for the intents the loaded modules need (GuildMembers is privileged).
const intents = new Set([GatewayIntentBits.Guilds]);
for (const m of [...commandModules, ...eventModules]) for (const i of m.intents || []) intents.add(GatewayIntentBits[i]);

const client = new Client({ intents: [...intents] });
client.commands = new Collection();
for (const cmd of commandModules) {
  if (cmd.data && cmd.execute) client.commands.set(cmd.data.name, cmd);
}
for (const ev of eventModules) {
  if (!ev.name || !ev.execute) continue;
  client[ev.once ? 'once' : 'on'](ev.name, (...args) => ev.execute(...args, client));
}

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag} with ${client.commands.size} command(s). Run "npm run deploy" once to register them.`);
});

client.on(Events.InteractionCreate, async interaction => {
  const command = interaction.isChatInputCommand() || interaction.isAutocomplete()
    ? client.commands.get(interaction.commandName)
    : null;
  if (interaction.isButton()) {
    for (const cmd of client.commands.values()) {
      if (cmd.buttons && interaction.customId.startsWith(cmd.buttons)) return cmd.onButton(interaction).catch(console.error);
    }
    return;
  }
  if (!command) return;
  try {
    if (interaction.isAutocomplete()) return command.autocomplete && command.autocomplete(interaction);
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const reply = { content: '❌ Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

client.login(token);
