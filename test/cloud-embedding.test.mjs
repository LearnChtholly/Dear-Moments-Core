import test from 'node:test';import assert from 'node:assert/strict';import {embedMany} from '../app/providers.mjs';
test('unapproved cloud embedding is rejected before network',async()=>{
 const p={kind:'compatible',embeddingKind:'compatible',baseUrl:'https://example.invalid',embeddingBaseUrl:'https://example.invalid',embedding:'x',embeddingCloudConsent:false};
 await assert.rejects(()=>embedMany(p,['x']),/授权|consent/i);
});
