// Simple Discord.js v14 bot hosted on OmniHost.
// Set DISCORD_BOT_TOKEN in the Environment tab, then press Start.
const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Cannot start: DISCORD_BOT_TOKEN is empty. Add it in the Environment tab.');
  process.exit(1);
}

// MessageContent is a privileged intent: enable it in the Developer Portal (Bot → Privileged Gateway Intents)
// or remove it (and the !ping handler) if you only use slash commands.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive')
].map(c => c.toJSON());

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag} — serving ${c.guilds.cache.size} server(s)`);
  try {
    await new REST().setToken(token).put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log('Slash commands registered (global commands can take a few minutes to appear).');
  } catch (err) {
    console.error('Could not register slash commands:', err.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') {
    await interaction.reply(`🏓 Pong! Gateway ping: ${client.ws.ping}ms`);
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (message.content === '!ping') await message.reply(`🏓 Pong! Gateway ping: ${client.ws.ping}ms`);
});

process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

client.login(token);
