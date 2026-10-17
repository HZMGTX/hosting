// Telegram bot hosted on OmniHost. Create a bot with @BotFather, then set TELEGRAM_BOT_TOKEN in the Environment tab.
const { Bot } = require('grammy');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Cannot start: TELEGRAM_BOT_TOKEN is empty. Add it in the Environment tab.');
  process.exit(1);
}

const bot = new Bot(token);
const started = Date.now();

bot.command('start', ctx => ctx.reply(`Hi ${ctx.from.first_name}! I'm hosted 24/7 on OmniHost. Try /ping.`));
bot.command('ping', ctx => ctx.reply(`🏓 Pong! Up for ${Math.round((Date.now() - started) / 1000)}s.`));
bot.on('message:text', ctx => ctx.reply(`You said: ${ctx.message.text}`));

bot.catch(err => console.error('Bot error:', err.error));

process.once('SIGTERM', () => bot.stop());
process.once('SIGINT', () => bot.stop());

bot.start({ onStart: me => console.log(`Logged in as @${me.username}`) });
