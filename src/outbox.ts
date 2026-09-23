import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WindowBudget, likelySecret } from './policy.js';

interface Proposal { id: string; actor: string; target: string; text: string; expires: number }
export interface OutboxContext { userId: string; isDm: boolean; canManage: boolean }
export class Outbox {
  private consent: Record<string,boolean> = {};
  private proposals = new Map<string,Proposal>();
  private drafts = new WindowBudget(10,3_600_000);
  private sends = new WindowBudget(3,3_600_000);
  constructor(readonly file: string | undefined, readonly judge: (text: string) => Promise<number>, readonly send: (userId:string,text:string,stillAuthorized:()=>boolean)=>Promise<void>, readonly clock = Date.now) {
    try {
      if (file && existsSync(file)) this.consent = z.record(z.string(),z.boolean()).parse(JSON.parse(readFileSync(file,'utf8')));
    } catch { throw new Error('Outreach consent file invalid; refusing to guess permissions.'); }
  }
  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    writeFileSync(`${this.file}.tmp`,JSON.stringify(this.consent),{mode:0o600});
    renameSync(`${this.file}.tmp`,this.file);
  }
  async command(ctx: OutboxContext, name: string, argument: string): Promise<string> {
    for (const [id,p] of this.proposals) if (p.expires <= this.clock()) this.proposals.delete(id);
    if (name === 'outreach') {
      if (!ctx.isDm) return 'DM me !audrey outreach on/off so I can record YOUR permission privately.';
      if (!['on','off'].includes(argument)) return 'Use outreach on or outreach off.';
      if (argument === 'on') this.consent[ctx.userId] = true;
      else {
        delete this.consent[ctx.userId];
        for (const [id,p] of this.proposals) if (p.target === ctx.userId) this.proposals.delete(id);
      }
      this.save();
      return argument === 'on' ? 'You opted into admin-approved outreach DMs from Audrey. Revoke any time with !audrey outreach off. This does not enable memory.' : 'Outreach permission removed and pending DMs to you cancelled.';
    }
    if (!ctx.canManage) return 'Outreach tools require Manage Server permission or the configured owner.';
    if (name === 'outbox') return [...this.proposals.values()].filter(p=>p.actor===ctx.userId).map(p=>`${p.id} → ${p.target}: ${p.text}`).join('\n\n') || 'No pending drafts. Propose with !audrey propose USER_ID | exact message text';
    if (name === 'propose') {
      const match = argument.match(/^(\d{17,20})\s*\|\s*([\s\S]+)$/);
      if (!match) return 'Use propose USER_ID | exact message text. Recipient must first DM !audrey outreach on.';
      const target = match[1]!; const text = match[2]!.trim();
      if (!this.consent[target]) return 'Recipient has not opted into outreach; no model call or message made.';
      if (!text || text.length > 1_000 || likelySecret(text)) return 'Draft must be 1–1000 characters and contain no apparent credentials.';
      if (!this.drafts.take(this.clock())) return 'Draft budget exhausted (10/hour).';
      let probability;
      try { probability = await this.judge(text); } catch { return 'Jev check failed; no draft created.'; }
      if (!Number.isFinite(probability) || probability < 0.9 || probability > 1) return 'Jev did not clear this draft at the fixed 0.9 threshold. Nothing sent.';
      if (!this.consent[target]) return 'Consent was revoked during evaluation. Nothing sent.';
      const proposal = {id:randomUUID().slice(0,8),actor:ctx.userId,target,text,expires:this.clock()+5*60_000};
      this.proposals.set(proposal.id,proposal);
      return `DM PROPOSAL ${proposal.id} → ${target}\n${text}\n\nJev clearance: ${probability.toFixed(2)} (not a safety guarantee). Nothing sent. Approve the exact target and text within five minutes: !audrey send ${proposal.id}`;
    }
    if (name === 'send') {
      const proposal = this.proposals.get(argument);
      if (!proposal || proposal.actor !== ctx.userId) return 'No unexpired proposal belonging to you.';
      this.proposals.delete(argument); // Single-use, including failed sends.
      if (!this.consent[proposal.target]) return 'Recipient consent revoked; blocked.';
      if (!this.sends.take(this.clock())) return 'Send budget exhausted (3/hour).';
      try { await this.send(proposal.target,proposal.text,()=>this.consent[proposal.target] === true && this.clock() < proposal.expires); return 'Approved DM sent. Proposal consumed.'; }
      catch { return 'DM failed (possibly closed DMs). Proposal consumed; no automatic retry.'; }
    }
    return 'Unknown outreach command.';
  }
}
