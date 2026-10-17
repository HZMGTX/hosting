const { SlashCommandBuilder, EmbedBuilder, InteractionContextType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server').setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    const g = interaction.guild;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(g.name)
      .setThumbnail(g.iconURL())
      .addFields(
        { name: 'Members', value: String(g.memberCount), inline: true },
        { name: 'Channels', value: String(g.channels.cache.size), inline: true },
        { name: 'Roles', value: String(g.roles.cache.size), inline: true },
        { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true }
      );
    await interaction.reply({ embeds: [embed] });
  }
};
