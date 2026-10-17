const { Events, EmbedBuilder } = require('discord.js');

// Needs the "Server Members" privileged intent enabled in the Developer Portal.
module.exports = {
  name: Events.GuildMemberAdd,
  intents: ['GuildMembers'],
  async execute(member) {
    const channelId = process.env.WELCOME_CHANNEL_ID;
    const channel = (channelId && member.guild.channels.cache.get(channelId)) || member.guild.systemChannel;
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle(`Welcome to ${member.guild.name}!`)
        .setDescription(`Hey ${member}, glad you're here. You are member #${member.guild.memberCount}.`)
        .setThumbnail(member.user.displayAvatarURL());
      await channel.send({ embeds: [embed] }).catch(err => console.error('Welcome message failed:', err.message));
    }
    const roleId = process.env.AUTO_ROLE_ID;
    if (roleId) {
      await member.roles.add(roleId, 'Auto-role on join').catch(err => console.error('Auto-role failed:', err.message));
    }
  }
};
