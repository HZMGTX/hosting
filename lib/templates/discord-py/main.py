"""discord.py bot hosted on OmniHost. Set DISCORD_BOT_TOKEN in the Environment tab, then press Start."""
import os
import sys

import discord
from discord import app_commands

TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
if not TOKEN:
    print("Cannot start: DISCORD_BOT_TOKEN is empty. Add it in the Environment tab.", file=sys.stderr)
    sys.exit(1)

intents = discord.Intents.default()


class Bot(discord.Client):
    def __init__(self):
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        synced = await self.tree.sync()
        print(f"Synced {len(synced)} slash command(s) (global commands can take a few minutes to appear).")


bot = Bot()


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} — serving {len(bot.guilds)} server(s)")


@bot.tree.command(name="ping", description="Check that the bot is alive")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message(f"🏓 Pong! Gateway ping: {round(bot.latency * 1000)}ms")


bot.run(TOKEN)
