export type ModelStage='affect'|'appraisal'|'decision'|'writer';
export class EscapeModelError extends Error {
  constructor(readonly stage:ModelStage,cause:unknown) {super('Escape model request failed',{cause});}
}
export function failureInfo(error:unknown):{category:string;status?:number} {
  if (error instanceof EscapeModelError) return failureInfo(error.cause);
  if (!error || typeof error!=='object') return {category:'unknown'};
  const e=error as {name?:string;statusCode?:number;cause?:unknown};
  if (e.name==='TimeoutError' || e.name==='AbortError') return {category:'timeout'};
  if (e.name==='UngroundedSpeechError') return {category:'ungrounded_dialogue'};
  if (e.name==='RepeatedSpeechError') return {category:'repeated_dialogue'};
  if (e.name==='ZodError' || e.name==='AI_TypeValidationError' || e.name==='AI_NoObjectGeneratedError') return {category:'invalid_response'};
  if (Number.isInteger(e.statusCode)) return {category:e.statusCode===429 ? 'rate_limit' : 'provider',status:e.statusCode};
  if (e.cause) return failureInfo(e.cause);
  return {category:'internal'};
}
// Only bounded metadata. SDK errors can embed prompts, headers and credentials in their messages.
export function reportModelFailure(stage:ModelStage,error:unknown):void {
  console.warn(JSON.stringify({event:'escape_model_failure',stage,...failureInfo(error)}));
}
export async function modelRequest<T>(stage:ModelStage,request:()=>Promise<T>):Promise<T> {
  try {return await request();}
  catch(error) {
    const {category,status}=failureInfo(error);
    if (category==='timeout' || category==='rate_limit' || status!==undefined && status>=500) {
      reportModelFailure(stage,error);
      await new Promise(r=>setTimeout(r,350));
      try {return await request();} catch(retryError) {throw new EscapeModelError(stage,retryError);}
    }
    throw new EscapeModelError(stage,error);
  }
}
