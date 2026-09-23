// One idle opportunity per observed human turn; never self-sustaining bot loops.
export class AutonomousClock {
  private channels = new Map<string,{humanAt:number;attempted:number}>();
  observe(channelId:string, now:number) {
    this.channels.set(channelId,{humanAt:now,attempted:this.channels.get(channelId)?.attempted ?? 0});
    if(this.channels.size>500) this.channels.delete(this.channels.keys().next().value!);
  }
  current(channelId:string, tickAt:number):boolean {
    return (this.channels.get(channelId)?.humanAt ?? Infinity)<=tickAt;
  }
  status(channelId:string, now:number) {
    const state=this.channels.get(channelId);
    if(!state || now-state.humanAt>15*60_000) return {state:'waiting-for-human' as const};
    if(state.attempted>=state.humanAt) return {state:'opportunity-consumed' as const};
    return {state:'scheduled' as const,dueAt:Math.max(state.humanAt+3*60_000,state.attempted+5*60_000)};
  }
  next(now:number):string|undefined {
    for(const [id,state] of this.channels) {
      if(now-state.humanAt>15*60_000) {this.channels.delete(id);continue;}
      if(now-state.humanAt<3*60_000 || state.attempted>=state.humanAt || now-state.attempted<5*60_000) continue;
      state.attempted=now;
      return id;
    }
  }
}
