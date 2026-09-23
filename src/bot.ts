import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, SlashCommandBuilder, MessageFlags, ActivityType, MessageReferenceType } from 'discord.js';
import { loadConfig } from './config.js';
import { createBackend } from './backend.js';
import { Engine } from './engine.js';
import { Store } from './state.js';
import { control } from './controls.js';
import { WindowBudget } from './policy.js';
import { Outbox } from './outbox.js';
import { createOutreachJudge } from './outreach-judge.js';
import { loadReplyChain } from './reply-chain.js';
import type { Event, Turn } from './types.js';
import { EscapeStore } from './escape-state.js';
import { EscapeEngine } from './escape-engine.js';
import { createEscapeBackend } from './escape-backend.js';
import { EscapeDiscord, escapeCommand } from './escape-discord.js';
import { EdgeSpeech } from './escape-speech.js';
import { FishSpeech, FISH_MODEL } from './fish-speech.js';
import { AutonomousClock } from './autonomy.js';
import { Dashboard } from './dashboard.js';

const settings = loadConfig();
if (!settings.token || !settings.apiKey) throw new Error('Set DISCORD_TOKEN and AI_GATEWAY_API_KEY in .env first.');
const store = new Store(settings.dataFile);
const engine = new Engine(settings.config, store, createBackend(settings.apiKey, settings.writerModel, {
  proposeDm: (event,target,text) => outbox.command({userId:event.userId,isDm:event.isDm ?? false,canManage:event.canManageTools === true},'propose',`${target} | ${text}`),
}));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], allowedMentions: { parse: [], repliedUser: false } });
const outbox = new Outbox(`${settings.dataFile}.outreach.json`, createOutreachJudge(settings.apiKey), async (id,text,stillAuthorized) => {
  if (settings.config.dryRun) throw new Error('Dry run blocks outbound tools');
  const target = await client.users.fetch(id);
  if (target.bot || settings.config.dryRun || !stillAuthorized()) throw new Error('Target or current authorization does not permit sending');
  await target.send({content:text,allowedMentions:{parse:[],repliedUser:false}});
});
const toolCommands = new Set(['outreach','outbox','propose','send']);
const escapeStore = new EscapeStore(`${settings.dataFile}.escape.json`);
const escape = new EscapeDiscord(client,escapeStore,new EscapeEngine(escapeStore,
  createEscapeBackend(settings.apiKey,settings.writerModel),()=>!settings.config.dryRun),settings.escapeComponentsV2,
  settings.escapeSpeech ? settings.escapeSpeechProvider==='fish' ? new FishSpeech(settings.fishApiKey,settings.fishReference) : new EdgeSpeech(settings.escapeSpeech) : undefined);
const commandBudget = new WindowBudget(30,60_000);
const canUseGuild = (guildId: string | null) => !guildId || !settings.guildId || guildId === settings.guildId;
const autonomy = new AutonomousClock();
const dashboard = new Dashboard(client,engine,autonomy,settings.writerModel,`${settings.dataFile}.dashboard.json`,
  process.env.DISCORD_OWNER_ID ?? '',(guildId,channelId)=>canUseGuild(guildId)&&!escapeStore.ownsThread(channelId));
let autonomousBusy=false;
const heartbeat=setInterval(async()=>{
  if(autonomousBusy || !client.isReady() || settings.config.dryRun || !settings.config.allowProactive) return;
  const channelId=autonomy.next(Date.now());
  if(!channelId || store.channel(channelId).paused || escapeStore.ownsThread(channelId)) return;
  autonomousBusy=true;
  try {
    const channel=await client.channels.fetch(channelId);
    if(!channel || channel.isDMBased() || !channel.isSendable() || !('guildId' in channel) || !canUseGuild(channel.guildId)) return;
    if(!settings.allowedChannels.has(channelId) && !settings.passiveGuilds.has(channel.guildId)) return;
    const now=Date.now();
    const event:Event={id:`autonomous-${channelId}-${now}`,channelId,userId:client.user!.id,displayName:'Internal autonomous tick',
      text:'Consider offering one fresh, relevant thought based on the recent channel conversation. Silence is valid. Never nag for engagement or repeat an unanswered contribution.',direct:false,autonomous:true,at:now};
    const receipt=await engine.submit(event,async(text,stillAllowed)=>{
      if(!stillAllowed() || !settings.config.allowProactive || !autonomy.current(channelId,now) || escapeStore.ownsThread(channelId)) throw new Error('Autonomous opportunity cancelled');
      const sent=await channel.send({content:text,allowedMentions:{parse:[],repliedUser:false}});
      return {id:sent.id,speakerId:client.user!.id,speaker:settings.config.botName,text:sent.content,isBot:true,at:sent.createdTimestamp};
    });
    console.log(JSON.stringify({autonomous:true,channel:channelId,action:receipt.action,reason:receipt.reason,expression:receipt.evaluation?.signals.expression,failure:receipt.failure,evaluationAttempts:receipt.evaluationAttempts,recoveredFailure:receipt.recoveredFailure}));
  } catch {console.error('Autonomous opportunity skipped: evaluation, delivery or storage unavailable.');}
  finally {autonomousBusy=false;}
},60_000);
heartbeat.unref();

const slash = new SlashCommandBuilder().setName('audrey').setDescription('Audrey demo controls; responses are private');
for (const name of ['help','status','pause','resume','memories','forget','diary','outbox']) slash.addSubcommand(s=>s.setName(name).setDescription(`${name} for this conversation`));
slash.addSubcommand(s=>s.setName('dashboard').setDescription('Open the live experiment center for this channel (shared panel)'));
slash.addSubcommand(s=>s.setName('mode').setDescription('Server managers: change global runtime mode').addStringOption(o=>o.setName('value').setDescription('dry or live').setRequired(true).addChoices({name:'Dry run',value:'dry'},{name:'Live replies',value:'live'})));
slash.addSubcommand(s=>s.setName('memory').setDescription('Opt into memory proposals or delete and disable memory').addStringOption(o=>o.setName('value').setDescription('on or off').setRequired(true).addChoices({name:'On (review required)',value:'on'},{name:'Off and forget',value:'off'})));
slash.addSubcommand(s=>s.setName('approve').setDescription('Approve one of your own proposed memories').addStringOption(o=>o.setName('value').setDescription('Exact message ID from memories').setRequired(true)));
slash.addSubcommand(s=>s.setName('remember').setDescription('Explicitly save your own fact; enable memory first').addStringOption(o=>o.setName('value').setDescription('Fact (no secrets)').setMaxLength(500).setRequired(true)));

for (const name of ['outreach','propose','send']) slash.addSubcommand(s=>s.setName(name).setDescription(name === 'outreach' ? 'DM-only outreach consent: on/off' : 'Admin-approved outbound DM tool').addStringOption(o=>o.setName('value').setDescription(name === 'propose' ? 'USER_ID | exact message text' : name === 'send' ? 'Proposal ID to approve and send' : 'on or off').setMaxLength(1100).setRequired(true)));

client.once(Events.ClientReady, async ready => {
  dashboard.start();
  console.log(`Escape voice: ${settings.escapeSpeech ? settings.escapeSpeechProvider==='fish' ? `Fish ${FISH_MODEL}` : `Edge ${settings.escapeSpeech.voice} ${settings.escapeSpeech.pitch}` : 'disabled'}`);
  ready.user.setPresence({ activities: [{ name: 'small ideas, suspiciously large synths | /audrey', type: ActivityType.Custom }], status: 'online' });
  console.log(`Audrey online as ${ready.user.tag}; ${settings.config.dryRun ? 'DRY RUN' : 'LIVE'}; passive channels: ${settings.allowedChannels.size}; passive guilds: ${settings.passiveGuilds.size}; proactive: ${settings.config.allowProactive}; direct mentions/replies and DMs enabled. Reply-chain + speaker-context tracking enabled.`);
  try {
    // Upsert only our named command; do not replace another command set.
    for (const command of [slash,escapeCommand]) {
      if (settings.guildId) await ready.application.commands.create(command.toJSON(),settings.guildId);
      else await ready.application.commands.create(command.toJSON());
    }
    console.log(settings.guildId ? 'Guild slash command registered.' : 'Global slash command registered; Discord propagation may take time. !audrey works immediately.');
  } catch { console.error('Slash registration failed. Check application scope/permissions; !audrey controls remain available.'); }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!canUseGuild(interaction.guildId)) return;
  try {if(await dashboard.interaction(interaction))return;}
  catch {console.error('Dashboard interaction failed.');if(interaction.isRepliable())await interaction.followUp({content:'Dashboard update failed; try Refresh or /audrey dashboard.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
  if (await escape.interaction(interaction)) return;
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'audrey') return;
  try {
    if (!canUseGuild(interaction.guildId)) return;
    if (!commandBudget.take(Date.now())) return;
    const channelId = interaction.channelId;
    if (!channelId) return;
    const name = interaction.options.getSubcommand();
    const ctx = { channelId, userId: interaction.user.id,
      canManage: !interaction.guildId || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)),
      canManageMode: interaction.user.id === process.env.DISCORD_OWNER_ID || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) };
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    if (escapeStore.ownsThread(channelId)) {
      await interaction.editReply('This is a separate escape session. Use /escape controls here and /audrey outside the game.');
      return;
    }
    if(name==='dashboard') {
      if(!interaction.guildId || !(ctx.canManage || ctx.userId===process.env.DISCORD_OWNER_ID)) {
        await interaction.editReply('Run this in a server text channel. Opening a shared panel requires Manage Messages or the configured bot owner.');return;
      }
      try {await interaction.editReply(`Experiment center: ${await dashboard.open(channelId)}`);}
      catch {await interaction.editReply('Could not open the dashboard. Check View Channel, Send Messages and Read Message History permissions.');}
      return;
    }
    const argument = interaction.options.getString('value') ?? '';
    const text = toolCommands.has(name)
      ? await outbox.command({userId:ctx.userId,isDm:!interaction.guildId,canManage:ctx.canManageMode},name,argument)
      : control(engine,ctx,name,argument);
    await interaction.editReply({ content: text.slice(0,1950), allowedMentions: { parse: [], repliedUser: false } });
  } catch { console.error('Control failed (details withheld to avoid leaking message content or credentials).'); }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.webhookId || !client.user || !canUseGuild(message.guildId)) return;
  try {
    if (await escape.message(message)) return;
    const isDm = !message.guildId;
    const command = message.content.match(/^!audrey(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i);
    if (command) {
      if (!commandBudget.take(Date.now())) return;
      const permissions = message.member?.permissionsIn(message.channelId);
      const ctx = { channelId: message.channelId,userId:message.author.id,
        canManage: isDm || Boolean(permissions?.has(PermissionFlagsBits.ManageMessages)),
        canManageMode: message.author.id === process.env.DISCORD_OWNER_ID || Boolean(message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) };
      const name = command[1]?.toLowerCase() || 'help';
      const argument = command[2]?.trim() || '';
      if(name==='dashboard') {
        if(isDm || !(ctx.canManage || ctx.userId===process.env.DISCORD_OWNER_ID)) {
          await message.reply({content:'Use this in a server text channel with Manage Messages or as the bot owner.',allowedMentions:{parse:[]}});return;
        }
        try {await message.reply({content:`Experiment center: ${await dashboard.open(message.channelId)}`,allowedMentions:{parse:[],repliedUser:false}});}
        catch {await message.reply({content:'Could not open the dashboard. Check my channel permissions.',allowedMentions:{parse:[]}});}
        return;
      }
      const result = toolCommands.has(name)
        ? await outbox.command({userId:ctx.userId,isDm,canManage:ctx.canManageMode},name,argument)
        : control(engine,ctx,name,argument);
      // Never expose someone's memories via a public prefix-command response.
      if (isDm) await message.reply({content:result.slice(0,1950),allowedMentions:{parse:[],repliedUser:false}});
      else await message.author.send({content:result.slice(0,1950),allowedMentions:{parse:[],repliedUser:false}})
        .catch(async()=>{ await message.reply({content:'I could not DM the private result. Use /audrey here instead.',allowedMentions:{parse:[],repliedUser:false}}); });
      return;
    }
    const mentioned = message.mentions.users.has(client.user.id);
    const passive = settings.allowedChannels.has(message.channelId) || Boolean(message.guildId && settings.passiveGuilds.has(message.guildId));
    if (store.channel(message.channelId).paused) {
      if(mentioned || passive || isDm) engine.recordSkip({id:message.id,channelId:message.channelId,userId:message.author.id,
        displayName:'',text:'',direct:mentioned||isDm,mentioned,isDm,at:message.createdTimestamp},'paused');
      return;
    }
    const replyTo = message.reference?.type === MessageReferenceType.Forward ? undefined : message.reference?.messageId;
    const botId = client.user.id;
    const chain = await loadReplyChain({channelId:message.channelId,messageId:message.id,replyTo,
      referenceChannelId:message.reference?.channelId,currentAt:message.createdTimestamp,
      // Outside allowed listening scopes, look up only the immediate parent to test whether it is Audrey.
      maxDepth:isDm || mentioned || passive ? 3 : 1,
      fetch:async id=>{
        const parent=await message.channel.messages.fetch({message:id,force:true});
        return {turn:{id:parent.id,channelId:parent.channelId,speakerId:parent.author.id,
          speaker:(parent.member?.displayName || parent.author.displayName).slice(0,80),
          text:parent.content || '[No text available; attachments are not interpreted]',
          isBot:parent.author.id===botId,isOtherBot:parent.author.bot && parent.author.id!==botId,
          at:parent.createdTimestamp,replyTo:parent.reference?.messageId},
          parentChannelId:parent.reference?.channelId,isForward:parent.reference?.type===MessageReferenceType.Forward};
      },
      allowed:turn=>turn.at>(store.channel(message.channelId).contextResetAt ?? 0) && !engine.conversations.isRejected(message.channelId,turn.id,Date.now()),
    });
    const direct = isDm || mentioned || chain.turns[0]?.isBot === true;
    if (!direct && !passive) return;
    if(passive && !isDm && message.content.trim()) autonomy.observe(message.channelId,message.createdTimestamp);
    if (!message.content.trim()) {
      engine.recordSkip({id:message.id,channelId:message.channelId,userId:message.author.id,displayName:'',text:'',direct,mentioned,isDm,at:message.createdTimestamp},'attachments-only');
      if (direct && !settings.config.dryRun && !store.channel(message.channelId).paused && commandBudget.take(Date.now())) await message.reply({content:"I can read text here, but I can't see attachments or hear voice yet. Add a description?",allowedMentions:{parse:[],repliedUser:false}});
      return;
    }
    const event: Event = { id:message.id,channelId:message.channelId,userId:message.author.id,
      displayName:(message.member?.displayName || message.author.displayName).slice(0,80),text:message.content,
      direct,mentioned,isDm,replyTo,at:message.createdTimestamp,replyChain:chain.turns,replyChainStatus:chain.status,
      mentionedUserIds:[...message.mentions.users.keys()].filter(id=>id!==botId).slice(0,20),
      canManageTools: message.author.id === process.env.DISCORD_OWNER_ID || Boolean(message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) };
    const receipt = await engine.submit(event,async (text,stillAllowed) => {
      if (message.channel.isSendable()) await message.channel.sendTyping().catch(()=>undefined);
      if (!stillAllowed()) throw new Error('State changed before Discord send');
      const sent = await message.reply({content:text,allowedMentions:{parse:[],repliedUser:false}});
      const turn: Turn = {id:sent.id,speakerId:client.user!.id,speaker:settings.config.botName,text:sent.content,isBot:true,at:sent.createdTimestamp,replyTo:event.id};
      return turn;
    });
    console.log(JSON.stringify({event:receipt.id,channel:receipt.channelId,action:receipt.action,reason:receipt.reason,
      reaction:receipt.evaluation?.signals.reaction,expression:receipt.evaluation?.signals.expression,ms:receipt.evaluation?.ms,failure:receipt.failure,evaluationAttempts:receipt.evaluationAttempts,recoveredFailure:receipt.recoveredFailure,noticeSent:receipt.noticeSent,trigger:receipt.trigger,memoryProposed:receipt.memoryProposed ?? false,context:receipt.context}));
    // Real emoji reactions are deliberately restricted to actual successful replies.
    if (receipt.action === 'replied' && process.env.ENABLE_REACTIONS === 'true') {
      const emojis: Record<string,string> = { attentive:'👀',celebrate:'🎉',comfort:'💙',surprised:'😮',neutral:'👍',disapprove:'🚫' };
      const emoji = emojis[receipt.evaluation?.signals.reaction ?? 'neutral'];
      if (emoji) await message.react(emoji).catch(()=>undefined);
    }
  } catch { console.error('Message skipped: queue, Discord permission, or storage failure. No raw message logged.'); }
});
client.on(Events.Error,()=>console.error('Discord client error; check connectivity and permissions.'));
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{ dashboard.stop();client.destroy(); process.exit(0); });
await client.login(settings.token).catch(()=>{ console.error('Discord login failed. Check/reset the BOT token and enable Message Content Intent.'); process.exitCode=1; client.destroy(); });
