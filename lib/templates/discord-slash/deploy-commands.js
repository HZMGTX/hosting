// Registers every command in commands/ with Discord.
// With GUILD_ID set, commands appear instantly in that server; without it they are global (can take up to an hour).
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
if (!token || !clientId) {
  console.error('Set DISCORD_BOT_TOKEN and CLIENT_ID in the Environment tab first.');
  process.exit(1);
}

const dir = path.join(__dirname, 'commands');
const body = fs.readdirSync(dir)
  .filter(f => f.endsWith('.js'))
  .flatMap(f => {
    const mod = require(path.join(dir, f));
    return Array.isArray(mod) ? mod : [mod];
  })
  .filter(c => c.data)
  .map(c => c.data.toJSON());

(async () => {
  const rest = new REST().setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  const result = await rest.put(route, { body });
  console.log(`Registered ${result.length} command(s) ${guildId ? `in guild ${guildId}` : 'globally'}.`);
})().catch(err => {
  console.error('Failed to register commands:', err.message);
  process.exit(1);
});
