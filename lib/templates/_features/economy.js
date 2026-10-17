const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

// Small JSON-file store so balances survive restarts.
const FILE = path.join(__dirname, '..', 'data', 'economy.json');
let wallets = {};
try { wallets = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(wallets, null, 2));
  }, 500);
}
function wallet(id) {
  return (wallets[id] = wallets[id] || { coins: 100, lastDaily: 0 });
}

const DAILY = 250;
const DAY_MS = 24 * 3600 * 1000;

module.exports = [
  {
    data: new SlashCommandBuilder().setName('balance').setDescription('Show a coin balance')
      .addUserOption(o => o.setName('user').setDescription('Whose balance')),
    async execute(interaction) {
      const user = interaction.options.getUser('user') || interaction.user;
      await interaction.reply(`💰 **${user.username}** has **${wallet(user.id).coins}** coins.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('daily').setDescription(`Claim ${DAILY} coins once a day`),
    async execute(interaction) {
      const w = wallet(interaction.user.id);
      const wait = w.lastDaily + DAY_MS - Date.now();
      if (wait > 0) {
        return interaction.reply({ content: `⏳ Come back <t:${Math.floor((Date.now() + wait) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
      }
      w.coins += DAILY;
      w.lastDaily = Date.now();
      save();
      await interaction.reply(`🎁 You claimed **${DAILY}** coins! Balance: **${w.coins}**.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('coinflip').setDescription('Bet coins on a coin flip')
      .addIntegerOption(o => o.setName('bet').setDescription('How many coins').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const bet = interaction.options.getInteger('bet');
      const w = wallet(interaction.user.id);
      if (bet > w.coins) return interaction.reply({ content: `You only have ${w.coins} coins.`, flags: MessageFlags.Ephemeral });
      const win = Math.random() < 0.5;
      w.coins += win ? bet : -bet;
      save();
      await interaction.reply(win ? `🎉 Heads — you won **${bet}**! Balance: **${w.coins}**.` : `💀 Tails — you lost **${bet}**. Balance: **${w.coins}**.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('leaderboard').setDescription('Richest members'),
    async execute(interaction) {
      const top = Object.entries(wallets).sort((a, b) => b[1].coins - a[1].coins).slice(0, 10);
      const lines = top.map(([id, w], i) => `**${i + 1}.** <@${id}> — ${w.coins} coins`);
      const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('🏆 Leaderboard').setDescription(lines.join('\n') || 'Nobody has coins yet.');
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  }
];
