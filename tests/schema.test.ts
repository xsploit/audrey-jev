import test from 'node:test';
import assert from 'node:assert/strict';
import { dmDraftSchema } from '../src/backend.js';
test('native DM tool accepts Discord snowflake strings and rejects malformed targets',()=>{
  assert.equal(dmDraftSchema.parse({userId:'123456789012345678',text:'hello'}).userId,'123456789012345678');
  assert.throws(()=>dmDraftSchema.parse({userId:'@everyone',text:'hello'}));
  assert.throws(()=>dmDraftSchema.parse({userId:123456789012345678,text:'hello'}));
  assert.throws(()=>dmDraftSchema.parse({userId:'123456789012345678',text:''}));
});
