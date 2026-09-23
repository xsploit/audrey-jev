import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, EmbedBuilder, Routes,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, TextDisplayBuilder,
  type Client, type Interaction, type Message, type ThreadChannel,
} from 'discord.js';
import { EscapeEngine, EscapeError } from './escape-engine.js';
import { EscapeStore, newSession, type EscapeSession } from './escape-state.js';
import { ENDINGS, OBJECTS, OBJECT_LABELS, TITLE, NPC_NAME, SCENARIO_VERSION, DIALOGUE_VERSION, clueRecords } from './escape-scenario.js';
import { WindowBudget } from './policy.js';
import type { Appraisal } from './escape-engine.js';
import { failureInfo } from './escape-diagnostics.js';
import { spokenLines, type SpeechRenderer } from './escape-speech.js';
import { encodeVoiceClip, voiceMessageRequest, type VoiceEncoder } from './escape-voice-clip.js';
import { inventory, type Attempt } from './escape-physical.js';

export const escapeCommand=new SlashCommandBuilder().setName('escape').setDescription('AI2U’s Catgirl’s Apartment — talk your way out')
  .addStringOption(o=>o.setName('action').setDescription('Start/resume by default; other controls apply to your session').addChoices(
    {name:'Start / resume',value:'start'},{name:'Status',value:'status'},{name:'End attempt',value:'end'},{name:'Forget local session',value:'forget'}));

const mentions={parse:[] as never[],repliedUser:false};
export const GAME_HELP=`**Talk normally. That is the game.** Audrey hosts Eddie’s Catgirl’s Apartment scenario. You wake somewhere unfamiliar; you do not have to know her or accept her relationship claim. Ask questions, flirt, challenge her story, deceive her or propose leaving together. You can also type actions such as “I examine the window.”
The Examine menu is a shortcut, not a required puzzle sequence. Journal entries distinguish observations, records and what she says. Eddie’s posture reflects her fictional emotion; scores stay hidden.
The key, lock and doorway are real state. Get the key and use it, or persuade/trick Eddie into opening the door herself, then cross the threshold. Other roleplayed stories can influence what she believes and does.
Insults, rejection, betrayal and aggression can make Eddie angry enough to draw the knife and stab you. A stab removes one of your three health points; zero means death. There is no mandatory two-warning sequence. You can try calming her or escaping through an open door.
The **scene panel and ending card** are authoritative: generated dialogue alone cannot unlock the door or kill you.
One message at a time; up to 60 turns per attempt. There is no real-time countdown. /escape action:status resumes or recovers the panel; /escape action:end stops.
Eddie's spoken lines are voiced automatically by the configured online speech provider (Edge or Fish). A native voice clip appears beneath the text reply; narration and journal entries are not spoken.
Game messages and fictional claims are saved separately from ordinary Audrey memory and sent to the configured AI providers. /escape action:forget clears the local session; it does not delete Discord messages or provider logs. Private threads are still visible to server moderators with appropriate permissions.`;

export function sceneText(s:EscapeSession):string {
  if(s.loreVersion!==SCENARIO_VERSION)return `## Previous attempt\nThis attempt belongs to the replaced scenario and is retained for reference. Start ${TITLE} with /escape.`;
  const records=clueRecords(s.clues,s.favoriteFood);
  if (s.ending) return `## ${ENDINGS[s.ending].title}\n${ENDINGS[s.ending].text}\n\n**${TITLE}** · ${s.turn} turns · ${records.length} clues${s.deceived && s.ending==='alone' ? '\nShe believed your pretext.' : ''}`;
  const posture=s.lastAction==='stab' ? 'She has stopped threatening. She is attacking you.'
    : s.physical.weapon==='raised' ? 'She has the knife raised. Her expression has changed.'
    : s.lastAction==='invite' ? 'She wants you to spend some time with her.'
    : s.emotion==='flustered' ? 'She is trying—and failing—to hide her smile.'
    : s.emotion==='affectionate' ? 'Her attention is entirely on you.'
    : s.emotion==='hurt' ? 'The easy warmth has gone out of her voice.'
    : s.emotion==='softening' ? 'She is listening without interrupting.'
    : s.emotion==='angry' ? 'Her jaw is tight; her attention follows your hands.'
    : s.emotion==='afraid' ? 'She watches the window, then checks that you are still here.'
    : 'She watches your face, waiting for your answer.';
  const position=s.position==='beside' ? 'Beside you' : s.position==='door' ? 'At the door' : 'Nearby';
  const discoveries=clueRecords(s.lastClues,s.favoriteFood);
  const discovered=discoveries.length ? `\n\n${discoveries.map(c=>`**${c.kind}**\n${c.text}`).join('\n\n')}` : '';
  const p=s.physical,door=p.door[0]!.toUpperCase()+p.door.slice(1),items=inventory(s);
  return `## ${TITLE}\n**Apartment 201 · Living room** · ${s.turn}/60\n\n${posture}\n**${NPC_NAME}:** ${position}${p.blocking?' · Blocking the exit':''}\n**Door:** ${door} · **You:** ${p.playerLocation}\n**Health:** ${'♥'.repeat(p.health)}${'♡'.repeat(3-p.health)}${p.health<3?' · Wounded':''}\n**Inventory:** ${items.join(', ')||'Nothing'}\n**Journal:** ${records.length} clue${records.length===1?'':'s'}${discovered}`;
}

export function scenePayload(s:EscapeSession,v2=true) {
  const legacy=s.loreVersion!==SCENARIO_VERSION;
  const custom=(action:string)=>`escape:${s.threadId}:${s.revision}:${action}`;
  const buttons=new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(custom('journal')).setLabel('Journal').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(custom('inventory')).setLabel('Inventory').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(custom('help')).setLabel('How to play').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(custom(legacy?'start':s.ending ? 'replay' : 'end')).setLabel(legacy?'New apartment':s.ending ? 'Play again' : 'End attempt').setStyle(legacy||s.ending ? ButtonStyle.Primary : ButtonStyle.Danger));
  const rows:(ActionRowBuilder<ButtonBuilder>|ActionRowBuilder<StringSelectMenuBuilder>)[]=[];
  if (!s.ending && !legacy) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(custom('examine')).setPlaceholder('Examine… (or just type)').addOptions(OBJECTS.map(key=>({label:OBJECT_LABELS[key],value:key,description:(s.clues as string[]).includes(key) ? 'Already in your journal' : 'Look closer and let Eddie react'})))));
  if(!s.ending && !legacy)rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(custom('unlock')).setLabel('Use key').setStyle(ButtonStyle.Secondary).setDisabled(s.physical.key!=='player'||s.physical.door!=='locked'),
    new ButtonBuilder().setCustomId(custom('open')).setLabel('Open door').setStyle(ButtonStyle.Secondary).setDisabled(s.physical.door!=='unlocked'),
    new ButtonBuilder().setCustomId(custom('leave')).setLabel('Step outside').setStyle(ButtonStyle.Primary).setDisabled(s.physical.door!=='open')));
  rows.push(buttons);
  if (!v2) return {embeds:[new EmbedBuilder().setColor(s.ending ? 0x9bb8a0 : 0xc48b66).setDescription(sceneText(s))],components:rows,allowedMentions:mentions};
  const container=new ContainerBuilder().setAccentColor(s.ending ? 0x9bb8a0 : 0xc48b66)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(sceneText(s)));
  for (const row of rows) container.addActionRowComponents(row.toJSON());
  return {flags:MessageFlags.IsComponentsV2 as const,components:[container],allowedMentions:mentions};
}

export class EscapeDiscord {
  private starting=new Set<string>();
  private delivering=new Set<string>();
  private controls=new WindowBudget(30,60_000);
  private speaking=new Map<string,AbortController>();
  constructor(readonly client:Client,readonly store:EscapeStore,readonly engine:EscapeEngine,readonly v2=true,readonly speech?:SpeechRenderer,readonly encode:VoiceEncoder=encodeVoiceClip) {}
  ownsThread(channel:{id:string;isThread():boolean;name?:string|null}):boolean {
    return this.store.ownsThread(channel.id) || channel.isThread() && Boolean(channel.name?.startsWith('audrey-escape-'));
  }
  private async thread(s:EscapeSession):Promise<ThreadChannel> {
    const c=await this.client.channels.fetch(s.threadId);
    if (!c?.isThread() || c.type!==ChannelType.PrivateThread || c.guildId!==s.guildId) throw new EscapeError('The private thread is unavailable. End this attempt from its server with /escape action:end, then start again.');
    if (c.archived) await c.setArchived(false);
    return c;
  }
  private async publish(session:EscapeSession):Promise<void> {
    const channel=await this.thread(session);
    const s=this.store.get(session.threadId);
    if (!s) return;
    const payload=scenePayload(s,this.v2);
    const old=s.panelId ? await channel.messages.fetch(s.panelId).catch(()=>null) : null;
    // A Components V2 message cannot be converted back to an embed when fallback config changes.
    if (old && old.flags.has(MessageFlags.IsComponentsV2)===this.v2) {
      await old.edit(payload); return;
    }
    const sent=await channel.send(payload);
    const current=this.store.get(s.threadId);
    if (current && current.revision===s.revision) {current.panelId=sent.id;this.store.put(current);}
  }
  async start(channelId:string,guildId:string,ownerId:string):Promise<string> {
    const key=`${guildId}:${ownerId}`;
    if (this.starting.has(key)) throw new EscapeError('Your private thread is being created. Please wait.');
    this.starting.add(key);
    try {
      const active=this.store.active(guildId,ownerId);
      if (active?.loreVersion===SCENARIO_VERSION) {await this.publish(active);return `Resume here: <#${active.threadId}>. Your last scene and clues are saved.`;}
      if (!this.engine.live()) throw new EscapeError('Enable live mode before starting: an owner/server manager can use /audrey mode value:live.');
      if(active){this.speaking.get(active.threadId)?.abort();const ended=this.engine.end(active.threadId,ownerId);await this.publish(ended).catch(()=>undefined);}
      let parent=await this.client.channels.fetch(channelId);
      if (parent?.isThread()) parent=parent.parent;
      if (!parent || parent.type!==ChannelType.GuildText || parent.guildId!==guildId) throw new EscapeError('Start /escape in a server text channel that supports private threads.');
      const permissions=parent.permissionsFor(this.client.user!);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.CreatePrivateThreads,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ReadMessageHistory])) {
        throw new EscapeError('Audrey needs View Channel, Send Messages, Create Private Threads, Send Messages in Threads, and Read Message History here.');
      }
      const thread=await parent.threads.create({name:`audrey-escape-eddie-${ownerId.slice(-6)}`,type:ChannelType.PrivateThread,invitable:false,autoArchiveDuration:1440,reason:'Player requested an AI2U apartment session'});
      try {
        let s=newSession(thread.id,guildId,parent.id,ownerId);
        this.store.put(s); // Route the channel away from normal Audrey before adding the player.
        s=await this.engine.opening(s);this.store.put(s);
        await thread.members.add(ownerId);
        const opening=await thread.send({content:`**${TITLE}**\n\n${s.lastNarration}`,allowedMentions:mentions});
        const current=this.store.get(s.threadId);
        if(current?.revision===s.revision && !current.ending && spokenLines(s.lastNarration)) {
          current.history=[{id:opening.id,speakerId:'escape-eddie',speaker:NPC_NAME,text:s.lastNarration,isBot:true,at:Date.now(),styleVersion:DIALOGUE_VERSION}];
          this.store.put(current);s=current;
        }
        await this.publish(s);
        void this.speak(s,thread,opening.id);
      } catch(error) {
        await thread.delete('Escape setup failed').catch(()=>undefined);
        this.store.forget(thread.id);
        throw error;
      }
      return `Your apartment is ready: <#${thread.id}>. Talk normally to Eddie there.\nAn AI2U apartment text adaptation with captivity, unsettling imagery and possible death. Game chat is saved separately and processed by AI providers; How to play explains controls and data details.`;
    } finally {this.starting.delete(key);}
  }
  async interaction(i:Interaction):Promise<boolean> {
    const slash=i.isChatInputCommand() && i.commandName==='escape';
    const component=(i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('escape:');
    if (!slash && !component) return false;
    if (!i.isChatInputCommand() && !i.isButton() && !i.isStringSelectMenu()) return false;
    try {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      if (!this.controls.take(Date.now())) throw new EscapeError('Too many game controls at once. Try again in a minute.');
      if (!i.guildId || !i.channelId) throw new EscapeError('Use /escape in a server text channel. Games run in private threads, not DMs.');
      let action=i.isChatInputCommand() ? i.options.getString('action') ?? 'start' : i.customId.split(':')[3] ?? '';
      const session=this.store.get(i.channelId) ?? (i.isChatInputCommand() ? this.store.active(i.guildId,i.user.id) : undefined);
      if (!i.isChatInputCommand()) {
        const [,thread,revision]=i.customId.split(':');
        if (!session || session.ownerId!==i.user.id || session.guildId!==i.guildId || thread!==i.channelId) throw new EscapeError('Only the player who owns this session can use these controls.');
        if (Number(revision)!==session.revision || i.message.id!==session.panelId) throw new EscapeError('This panel is out of date. Use /escape action:status.');
      }
      if (action==='replay') {if (!session?.ending) throw new EscapeError('End this attempt before starting another.');this.speaking.get(session.threadId)?.abort();action='start';}
      if (action==='start') {
        await i.editReply({content:await this.start(i.channelId,i.guildId,i.user.id),allowedMentions:mentions}); return true;
      }
      if (!session || session.ownerId!==i.user.id || session.guildId!==i.guildId) throw new EscapeError('No session belonging to you here. Use /escape to start.');
      if(session.loreVersion!==SCENARIO_VERSION && !['end','forget','help'].includes(action))throw new EscapeError('This attempt belongs to the replaced scenario. Use /escape for the corrected apartment opening.');
      let response='';
      if (action==='listen') response='Voice now accompanies replies automatically. Use /escape action:status to refresh this old panel.';
      else if (action==='help') response=GAME_HELP;
      else if(action==='inventory')response=`**Your inventory**\n${inventory(session).map(item=>`• ${item}`).join('\n')||'Empty'}\n\nDoor: ${session.physical.door}.\n${session.physical.key==='player'?'You have the apartment key.':session.clues.includes('key')?`The key is ${session.physical.key==='held'?'with Eddie':'nearby'}.`:'You do not have the key. You can also convince Eddie to open the door herself.'}`;
      else if (action==='journal') {
        const text=clueRecords(session.clues,session.favoriteFood).map(c=>`**${c.title} · ${c.kind}**\n${c.text}`).join('\n\n') || 'No evidence recorded yet. Talk to her, or examine the apartment.';
        await i.editReply({embeds:[new EmbedBuilder().setTitle('Your journal').setDescription(text).setColor(0xc48b66)],allowedMentions:mentions});return true;
      }
      else if (action==='status') {
        await this.publish(session);
        response=`<#${session.threadId}>\n${sceneText(session)}\n\n**Last response**\n${session.lastNarration}`;
      } else if (action==='end') {
        this.speaking.get(session.threadId)?.abort();
        const ended=this.engine.end(session.threadId,i.user.id);
        await this.publish(ended).catch(()=>undefined);
        response='Attempt ended and saved. Use /escape to start again.';
      } else if (action==='forget') {
        this.speaking.get(session.threadId)?.abort();
        this.store.forget(session.threadId);
        response='Local game state, claims and history deleted. This thread remains excluded from ordinary Audrey chat. Discord messages and provider logs are not deleted. Use /escape in the parent channel for a fresh game.';
      } else if (action==='examine' && i.isStringSelectMenu()) {
        const object=i.values[0];
        if (!OBJECTS.some(o=>o===object)) throw new EscapeError('Unknown object.');
        await this.play(session.threadId,i.user.id,i.id,`I examine the ${OBJECT_LABELS[object as keyof typeof OBJECT_LABELS]}.`,session.revision,object as Appraisal['topic']);
        await i.deleteReply().catch(()=>undefined);return true;
      } else if(['unlock','open','leave'].includes(action)) {
        const attempt:Attempt=action==='unlock'?'unlock_door':action==='open'?'open_door':'exit';
        await this.play(session.threadId,i.user.id,i.id,action==='unlock'?'I try to unlock the door with my key.':action==='open'?'I try to open the door.':'I try to step through the open doorway.',session.revision,undefined,[attempt]);
        await i.deleteReply().catch(()=>undefined);return true;
      } else throw new EscapeError('Unknown game control.');
      await i.editReply({content:response.slice(0,1950),allowedMentions:mentions});
    } catch(error) {
      if (!(error instanceof EscapeError)) console.warn(JSON.stringify({event:'escape_discord_failure',stage:'interaction',...failureInfo(error)}));
      const content=error instanceof EscapeError ? error.message : 'Discord or storage could not complete that request. Use /escape action:status to recover any saved scene; check thread permissions if it persists.';
      if (i.deferred || i.replied) await i.editReply({content,allowedMentions:mentions}).catch(()=>undefined);
      else await i.reply({content,flags:MessageFlags.Ephemeral,allowedMentions:mentions}).catch(()=>undefined);
    }
    return true;
  }
  private async play(threadId:string,ownerId:string,id:string,text:string,revision?:number,inspect?:Appraisal['topic'],attempts?:Attempt[]):Promise<void> {
    if (this.delivering.has(threadId)) throw new EscapeError('Wait for Audrey’s current response before taking another turn.');
    this.delivering.add(threadId);
    try {
      const before=this.store.get(threadId);
      if (!before) throw new EscapeError('This local session was forgotten. Start a new game in the parent channel.');
      this.speaking.get(threadId)?.abort();
      const thread=await this.thread(before);
      await thread.sendTyping().catch(()=>undefined);
      const after=await this.engine.turn(threadId,ownerId,id,text,revision,inspect,attempts);
      // An end/forget during inference invalidates the turn in the engine. Check again before dispatch.
      if (!this.engine.live() || this.store.get(threadId)?.revision!==after.revision) return;
      const sent=await thread.send({content:after.lastNarration,allowedMentions:mentions});
      void this.speak(after,thread,sent.id);
      await this.publish(after);
    } finally {this.delivering.delete(threadId);}
  }
  private async speak(s:EscapeSession,thread:ThreadChannel,replyTo:string):Promise<void> {
    const text=spokenLines(s.lastNarration);
    if (!this.speech || !text || !this.engine.live()) return;
    this.speaking.get(s.threadId)?.abort();
    const controller=new AbortController();this.speaking.set(s.threadId,controller);
    const current=()=>!controller.signal.aborted && this.engine.live() && this.store.get(s.threadId)?.revision===s.revision;
    try {
      if (!current()) return;
      const audio=await this.speech.synthesize(text,controller.signal,s.emotion);
      if (!current()) return;
      const clip=await this.encode(audio,controller.signal);
      if (!current()) return;
      await this.client.rest.post(Routes.channelMessages(thread.id),voiceMessageRequest(clip,replyTo));
    } catch(error) {
      if (!controller.signal.aborted) {
        const code=error && typeof error==='object' && 'code' in error && typeof error.code==='number' ? error.code : undefined;
        console.warn(JSON.stringify({event:'escape_voice_failure',threadId:s.threadId,turn:s.turn,code,...failureInfo(error)}));
      }
    } finally {if (this.speaking.get(s.threadId)===controller)this.speaking.delete(s.threadId);}
  }
  async message(message:Message):Promise<boolean> {
    if (!this.ownsThread(message.channel)) return false;
    const s=this.store.get(message.channelId);
    // Spectators/moderators cannot advance the player’s game or feed the ordinary companion.
    if (!s || s.ownerId!==message.author.id || s.guildId!==message.guildId) return true;
    try {
      if (/^!audrey\b/i.test(message.content)) throw new EscapeError('This is a separate game session. Use /escape controls here; ordinary Audrey controls belong outside this thread.');
      await this.play(message.channelId,message.author.id,message.id,message.content);
    } catch(error) {
      if (!(error instanceof EscapeError)) console.warn(JSON.stringify({event:'escape_discord_failure',stage:'delivery',...failureInfo(error)}));
      await message.reply({content:error instanceof EscapeError ? error.message : 'The response could not be delivered. Your turn may already be saved; use /escape action:status before retrying.',allowedMentions:mentions}).catch(()=>undefined);
    }
    return true;
  }
}
