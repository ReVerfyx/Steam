'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {writePrivate, readJSON} = require('../src/core');
const {profilePaths, readyProfiles, excludedFromFree} = require('../src/profiles');
const {parsePage, buildCatalog, createClaimer} = require('../src/free-games');
function temp(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'steam-multi-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function page(ids,total) {return {success:1,total_count:total,results_html:ids.map(id=>`<a href="/app/${id}" data-ds-appid="${id}" class="search_result_row"><span class="title">Game ${id}</span></a>`).join('')};}
test('Profile paths separate tokens, keep legacy main and reject traversal/duplicates',t=>{
 const root=temp(t);const a=profilePaths(root,'main'),b=profilePaths(root,'second');
 assert.equal(a.config,path.join(root,'config.json'));assert.notEqual(a.data,b.data);
 for(const id of ['../main','/root','a b','all']) assert.throws(()=>profilePaths(root,id));
 writePrivate(a.config,{accountName:'Alice'});writePrivate(path.join(a.data,'session.json'),{});
 writePrivate(b.config,{accountName:'Bob'});assert.deepEqual(readyProfiles(root),['main']);
 writePrivate(b.config,{accountName:'ALICE'});assert.throws(()=>readyProfiles(root),/Повтор/);
});
test('Catalogue excludes Spacewar, keeps pages and resumes after HTTP failure',async t=>{
 const root=temp(t);let requests=0;
 await assert.rejects(buildCatalog(root,async()=>{requests++;return requests===1 ? {ok:true,json:async()=>page([570,480],4)} : {ok:false,status:429};},async()=>{}),/429/);
 assert.equal(readJSON(path.join(root,'data/free-catalog.json')).start,2);
 const result=await buildCatalog(root,async url=>{assert.equal(url.searchParams.get('start'),'2');return {ok:true,json:async()=>page([730,440],4)};},async()=>{});
 assert.equal(result.complete,true);assert.deepEqual(result.apps.map(a=>a.appid),[570,730,440]);
 assert.throws(()=>parsePage({success:0,results_html:'challenge'}));
});
test('License queue records grants, skips completed IDs and stops on rate limit without consuming app',async t=>{
 const root=temp(t),data=path.join(root,'accounts/a/data');let limited=0,calls=0;
 writePrivate(path.join(root,'data/free-catalog.json'),{apps:[{appid:480},{appid:570},{appid:730}]});
 const client={steamID:'test',requestFreeLicense:async ids=>{calls++;if(ids[0]===730)throw Object.assign(new Error('limit'),{eresult:84});return {grantedAppIds:[570],grantedPackageIds:[]};}};
 const tick=createClaimer(client,root,data,()=>{},()=>limited++);
 await tick();await tick();
 assert.equal(calls,2);assert.equal(limited,1);
 const state=readJSON(path.join(data,'free-progress.json'));assert.equal(state.done[570].result,'granted');assert.equal(state.done[730],undefined);assert.equal(state.done[480],undefined);
});
test('Transient license failures are retryable; no false success',async t=>{
 const root=temp(t);writePrivate(path.join(root,'data/free-catalog.json'),{apps:[{appid:570}]});
 const data=path.join(root,'p');let calls=0;
 const tick=createClaimer({steamID:'test',requestFreeLicense:async()=>{calls++;throw new Error('timeout');}},root,data,()=>{},()=>{});
 await tick();await tick();assert.equal(calls,2);assert.equal(fs.existsSync(path.join(data,'free-progress.json')),false);
});
test('Supervisor launches independent workers, dispatches claims and stops children cleanly',async t=>{
 const root=temp(t);
 writePrivate(path.join(root,'data/free-catalog.json'),{apps:[{appid:570}]});
 for(const [id,name] of [['main','Alice'],['second','Bob']]) {const p=profilePaths(root,id);writePrivate(p.config,{accountName:name,claimFree:true});writePrivate(path.join(p.data,'session.json'),{});}
 fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'src/cli.js'),`const fs=require('fs');const file=${JSON.stringify(path.join(root,'events'))};const id=process.argv[3];fs.appendFileSync(file,'start '+id+'\\n');process.send({type:'ready'});process.on('message',m=>{if(m.type==='claim')fs.appendFileSync(file,'claim '+id+'\\n')});process.on('SIGTERM',()=>{fs.appendFileSync(file,'stop '+id+'\\n');process.exit(0)});`);
 const modulePath=path.resolve(__dirname,'../src/supervisor.js');
 const proc=spawn(process.execPath,['-e',`require(${JSON.stringify(modulePath)}).supervise(${JSON.stringify(root)},{launchDelay:20,claimDelay:30,tickDelay:10})`],{stdio:'ignore'});
 t.after(()=>{if(proc.exitCode===null)proc.kill('SIGKILL');});
 let events='';const deadline=Date.now()+5000;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,30));events=fs.existsSync(path.join(root,'events'))?fs.readFileSync(path.join(root,'events'),'utf8'):'';if(events.includes('claim main')&&events.includes('claim second'))break;}
 assert.match(events,/claim main/);assert.match(events,/claim second/);
 const ended=once(proc,'exit');proc.kill('SIGTERM');const [code]=await ended;assert.equal(code,0);
 events=fs.readFileSync(path.join(root,'events'),'utf8');assert.match(events,/stop main/);assert.match(events,/stop second/);
 assert.equal(fs.existsSync(path.join(root,'data/supervisor.pid')),false);
});

test('ReVerfyx exclusion applies to login and alias regardless of case',()=>{
 assert.equal(excludedFromFree('main',{accountName:'ReVerfyx',claimFree:true}),true);
 assert.equal(excludedFromFree('REVERFYX',{accountName:'another_login'}),true);
 assert.equal(excludedFromFree('main',{accountName:' reverfyx '}),true);
 assert.equal(excludedFromFree('second',{accountName:'Bob'}),false);
 assert.equal(excludedFromFree('main',{accountName:'different_login',freeExcluded:true}),true);
});

test('Automatic migration preserves main and exclusions; timer is bounded and persists absolute deadline',()=>{
 const {autoConfig,durationMs,expired}=require('../src/profiles');
 const main={accountName:'ReVerfyx',games:[570]};
 assert.deepEqual(autoConfig('main',main),main);
 assert.deepEqual(autoConfig('alias',main),main);
 assert.deepEqual(autoConfig('acc1',{accountName:'test',games:[570]}),{accountName:'test',games:[],autoFree:true,claimFree:true});
 assert.equal(durationMs('1h'),3600000); assert.equal(durationMs('100d'),8640000000);
 for(const v of ['0h','101d','2401h','-1h','infinite']) assert.throws(()=>durationMs(v));
 assert.equal(expired({stopAt:1000},999),false);assert.equal(expired({stopAt:1000},1000),true);
 assert.equal(expired({},9999),false);
});
test('Automatic games wait for ownership, update while paused without claiming session, reset estimate',()=>{
 const {IdleController}=require('../src/core');let now=0;const calls=[];
 const c=new IdleController({gamesPlayed:g=>calls.push(g)},[],()=>{},()=>now);
 c.connect();assert.equal(c.snapshot().state,'waiting');assert.equal(calls.length,0);
 c.setGames([570]);assert.deepEqual(calls,[[570]]);
 now=5000;c.playing(true);c.setGames([730]);assert.equal(calls.length,1);
 c.playing(false);assert.deepEqual(calls[1],[730]);assert.equal(c.snapshot().estimatedSecondsPerGame,0);
 c.setGames([]);assert.deepEqual(calls[2],[]);assert.equal(c.snapshot().state,'waiting');
});
