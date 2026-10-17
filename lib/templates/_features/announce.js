const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, InteractionContextType, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('announce').setDescription('Post an announcement embed')
    .addStringOption(o => o.setName('message').setDescription('Announcement text').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption(o => o.setName('title').setDescription('Embed title'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(interaction.options.getString('title') || '📢 Announcement')
      .setDescription(interaction.options.getString('message').replace(/\\n/g, '\n'))
      .setFooter({ text: `Posted by ${interaction.user.tag}` })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    await interaction.reply({ content: `Posted in ${channel}.`, flags: MessageFlags.Ephemeral });
  }
};
